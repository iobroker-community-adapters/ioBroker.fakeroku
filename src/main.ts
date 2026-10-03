import * as utils from "@iobroker/adapter-core";
import { I18n } from "@iobroker/adapter-core";
import { join } from "node:path";
import { FakerokuDeviceManagement } from "./device-management";
import type { RokuAdvert } from "./discovery/ssdp-messages";
import { RokuSsdpResponder } from "./discovery/ssdp-responder";
import { CommandHandler } from "./command-handler";
import type { CommandEvent } from "./ecp/ecp-command";
import { EcpHttpServer } from "./ecp/ecp-http-server";
import { type DeviceType, keysForType } from "./ecp/state-model";
import { instanceObjectId, RESERVED_IDS } from "./lib/constants";
import { deviceTreeOf, toDeviceRows, type DeviceRow } from "./lib/device-config";
import { randomIdentity } from "./lib/device-identity";
import { detectLocalIPv4s, detectPrimaryIPv4, localAddressFor } from "./lib/detect-ip";
import { errText } from "./lib/err-text";
import { migrateNativeKeys, type NativeKeyMigration } from "./lib/native-key-migration";
import { tDesc, tName, tRaw } from "./lib/i18n";
import { coveredBy, KnownObjects } from "./lib/known-objects";
import { carriesAddress, chosenAddress, isOwnPeer, localNets } from "./lib/network-address";
import { planNativePrune, planObjectCleanup } from "./lib/object-cleanup";

/** Managed timeout for a stuck SSDP start (a busy port 1900 must not hang onReady). */
const SSDP_START_TIMEOUT_MS = 5000;
/** Proactive ssdp:alive interval so controllers find the device without searching. */
const SSDP_NOTIFY_INTERVAL_MS = 300_000;
/** How long to wait before trying again what does not run: a device whose ECP server is down, and discovery. */
const RETRY_INTERVAL_MS = 60_000;
/** The fleet's reason text while the adapter has nothing to report: it is off, or started and has not tried yet. */
const UNKNOWN_REASON = "Unknown";

/**
 * Keys the 0.1.x adapter declared and nothing reads any more: its own HTTP port and multicast
 * address (both fixed by the Roku protocol today) and one global identity (every device carries its
 * own now). js-controller never deletes a native key, so without the drop they stay in every
 * installation that came from there.
 */
const DROPPED_NATIVE_KEYS: NativeKeyMigration[] = [{ drop: "HTTP_PORT" }, { drop: "MULTICAST_IP" }, { drop: "UUID" }];

/**
 * `common` keys an earlier manifest declared and this one no longer does: `license` (0.1.1, replaced
 * by `licenseInformation`) and `singletonHost` (0.2.0, gone since 1.6.0). js-controller merges
 * `common` on every update and never removes a key, so they stay in every installation that came
 * from there; the fleet helper nulls them in the same single write as the settings.
 */
const DROPPED_COMMON_KEYS: NativeKeyMigration[] = [{ commonDrop: "license" }, { commonDrop: "singletonHost" }];

/**
 * The listen address moved to `bind` (fleet listen-port standard). Which legacy key holds the
 * user's CURRENT choice depends on the versions the installation went through:
 *
 * - `networkInterface` exists only on an instance that ran 0.6.0–1.6.1. Its admin showed exactly
 *   that key, and the adapter bound to it — "" meant all interfaces. It is the setting the user
 *   saw last, so it wins, and a `BIND` still lying next to it is only cleared. The old adapter's
 *   `BIND` had to be a concrete LAN address (it was also the advertised location), so letting it
 *   win would pin an instance that ran on "all interfaces" for months to an address from years ago.
 * - Without `networkInterface` the instance comes straight from the pre-0.6.0 adapter, and `BIND`
 *   is its setting.
 *
 * An empty legacy value becomes "0.0.0.0" — the admin's check skips an instance whose `bind` is
 * falsy, so a migrated "" would be as invisible as no key at all.
 *
 * @param native the instance's stored native settings
 * @returns the migrations for this installation, the obsolete 0.1.x keys included
 */
function bindKeyMigrations(native: Record<string, unknown>): NativeKeyMigration[] {
  const hasInterfaceKey = native.networkInterface !== undefined && native.networkInterface !== null;
  const bind: NativeKeyMigration[] = hasInterfaceKey
    ? [{ from: "networkInterface", to: "bind", coerce: toBindAddress }, { drop: "BIND" }]
    : [{ from: "BIND", to: "bind", coerce: toBindAddress }];
  return [...bind, ...DROPPED_NATIVE_KEYS, ...DROPPED_COMMON_KEYS];
}

/**
 * A legacy listen address in the form the admin can read.
 *
 * @param old the stored legacy value
 * @returns the address, or "0.0.0.0" when it holds nothing usable
 */
function toBindAddress(old: unknown): string {
  return typeof old === "string" && old.trim() ? old.trim() : "0.0.0.0";
}

/** A configured emulated Roku that is not running after the start, and why — for the one log line about it. */
interface DeviceFailure {
  /** The configured device name. */
  name: string;
  /** Why it does not run, in words the user can act on. */
  reason: string;
  /** Whether the minute retry brings it back by itself (a busy port), or only a changed setting does. */
  retried: boolean;
}

/**
 * Why an ECP server could not listen, in words the user can act on: a taken port names its likely holder, anything
 * else keeps the system's text.
 *
 * @param e the listen error
 * @param port the port the server tried
 * @returns the reason
 */
function listenFailure(e: unknown, port: number): string {
  return (e as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE"
    ? `port ${port} is already in use (another program or another instance holds it)`
    : `port ${port}: ${errText(e)}`;
}

/** One configured emulated Roku at runtime — its object tree exists; it listens while it has a server. */
interface DeviceRuntime {
  /** The id-safe device path segment. */
  readonly id: string;
  /** The configured device name, for log lines the user can act on. */
  readonly name: string;
  /** The advert (identity + port) this device answers under. */
  readonly advert: RokuAdvert;
  /** The emulated device type. */
  readonly type: DeviceType;
  /** The key names its type carries — only those have a state. */
  readonly keys: ReadonlySet<string>;
  /** Its ECP server while it listens; none while it waits for a retry or after its server died. */
  server?: EcpHttpServer;
  /** Why it does not listen, in words the user can act on — set when a start fails or the server dies. */
  reason?: string;
}

/**
 * ioBroker.fakeroku — Roku emulator (input side).
 *
 * Emulates one or more Roku devices on the LAN so that ECP/SSDP remotes
 * (Logitech Harmony or a Sofabaton X1/X2) trigger events in ioBroker:
 * a keypress lands in `<device>.command` and pulses `<device>.keys.<Key>`.
 */
export class Fakeroku extends utils.Adapter {
  private ssdp: RokuSsdpResponder | undefined;
  private notifyTimer: ioBroker.Interval | undefined;
  /** Every configured emulated Roku whose object tree this start created, by device id. */
  private readonly devices = new Map<string, DeviceRuntime>();
  /** Devices whose ECP server is down — it did not start, or it died; retried on a timer until they come up. */
  private pending: DeviceRuntime[] = [];
  /** Turns the remotes' commands into state writes. */
  private readonly commands = new CommandHandler({
    writeState: (id, val) => this.writeState(id, val),
    setTimeout: (callback, ms) => this.setTimeout(callback, ms),
    clearTimeout: timer => this.clearTimeout(timer),
    warn: message => this.log.warn(message),
  });
  /** The retry timer for {@link pending} and for discovery, armed only while something does not run. */
  private retryTimer: ioBroker.Timeout | undefined;
  /** Discovery is answering and announcing — one of the conditions of a healthy instance. */
  private discoveryUp = false;
  /** Discovery is down and the warning about it is written: repeats go to debug, its return to info. */
  private discoveryDown = false;

  /**
   * Set as the very first thing onUnload does. Everything that can still be in flight at
   * that moment asks it before it writes or starts anything: the minute retry can be sitting
   * in `await server.start()` when the host says stop, and would then register a server into
   * an already-cleared map and write info.connection TRUE after the closing FALSE.
   */
  private stopping = false;
  /**
   * The read-only states this adapter writes outside the command hot path (`info.connection`, the device counts, every
   * Roku's status, the key reset at start), as last known, keyed relative to the namespace. Primed once at start by
   * one bulk read, so a restart writes nothing blindly and no such state is ever read one by one; the indicators are
   * kept current by {@link writeIndicator}.
   */
  private readonly lastState = new Map<string, Pick<ioBroker.State, "val" | "ack" | "q">>();
  /** The adapter's objects as read at start, keyed relative to the namespace. */
  private ownObjects: ReadonlyMap<string, ioBroker.Object> = new Map();
  /** The own object tree, read once at start: every object write goes through it and reaches the database only on a change. */
  private readonly known = new KnownObjects(this);
  /** How many configured devices are expected to listen — the target info.connection compares against. */
  private expectedDevices = 0;
  /** The interface to bind to, or undefined for "all" — kept for the retry after onReady returned. */
  private bindIp: string | undefined;
  /** The chosen address does not exist on this host: the adapter listens on all addresses instead and is not healthy. */
  private bindMissing = false;
  /**
   * Device-manager backend: the emulated Rokus as cards with add/edit/delete.
   *
   * dm-utils subscribes to the adapter's `message` event from its own constructor, so creating the object IS the
   * wiring — and it happens in onReady right after `I18n.init`: js-controller delivers messages before `ready`, and a
   * card or dialog text built before the translations are loaded throws.
   */
  private deviceManagement: FakerokuDeviceManagement | undefined;

  // Construction seams for the two network-facing collaborators. Production uses
  // the real classes; the orchestration tests swap them for fakes so onReady's
  // wiring (per-device isolation, SSDP degradation, timers) is testable without
  // binding a port. Behaviour is unchanged — same constructors, same arguments.
  private makeEcpServer: (options: ConstructorParameters<typeof EcpHttpServer>[0]) => EcpHttpServer = options =>
    new EcpHttpServer(options);
  private makeSsdpResponder: (options: ConstructorParameters<typeof RokuSsdpResponder>[0]) => RokuSsdpResponder =
    options => new RokuSsdpResponder(options);

  /**
   * @param options adapter options passed through by js-controller
   */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({
      ...options,
      name: "fakeroku",
    });

    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  /**
   * The adverts of the devices that are actually listening — the basis for info.connection and discovery.
   *
   * @returns the listening devices' adverts
   */
  private get running(): RokuAdvert[] {
    return [...this.devices.values()].filter(d => d.server).map(d => d.advert);
  }

  /**
   * Green: everything runs — every configured Roku listens, discovery answers, the chosen address is the one in use.
   * Anything less is yellow (`info.connection` false) while the process keeps running, so the device manager stays
   * usable; red is only a process that is gone.
   *
   * @returns true when everything runs
   */
  private get healthy(): boolean {
    return (
      this.expectedDevices > 0 && this.running.length === this.expectedDevices && this.discoveryUp && !this.bindMissing
    );
  }

  /**
   * Write what runs, in one pass from the same runtime state: every Roku's `info.online` and `info.error`, the three
   * device counts, and {@link healthy} to `info.connection` — each only on a change.
   *
   * @returns once the writes landed (or nothing had to be written)
   */
  private async updateConnection(): Promise<void> {
    const total = this.expectedDevices;
    const online = this.running.length;
    await Promise.all([
      ...[...this.devices.values()].map(device =>
        this.markDevice(device.id, device.server ? "" : (device.reason ?? UNKNOWN_REASON)),
      ),
      this.writeIndicator("info.devicesTotal", total),
      this.writeIndicator("info.devicesOnline", online),
      this.writeIndicator("info.devicesAllOnline", total > 0 && online === total),
      this.writeIndicator("info.connection", this.healthy),
    ]);
  }

  /**
   * Write one Roku's status: online exactly while there is no reason against it.
   *
   * @param deviceId the id-safe device path segment
   * @param reason empty while it listens, `Unknown` while nothing is known, else why it does not listen
   * @returns once both writes landed (or nothing had to be written)
   */
  private async markDevice(deviceId: string, reason: string): Promise<void> {
    await Promise.all([
      this.writeIndicator(`${deviceId}.info.online`, reason === ""),
      this.writeIndicator(`${deviceId}.info.error`, reason),
    ]);
  }

  /**
   * Show the given Rokus as not running for a reason nobody knows yet, the counts with them, and `info.connection`
   * false — the start stamp (a crash or a power cut runs no shutdown code) and the last write of onUnload.
   * `info.devicesTotal` keeps its value: how many Rokus there are does not change because nobody looks.
   *
   * @param deviceIds the id-safe device path segments to mark
   * @returns once the writes landed (or nothing had to be written)
   */
  private async markOffline(deviceIds: readonly string[]): Promise<void> {
    await Promise.all([
      ...deviceIds.map(id => this.markDevice(id, UNKNOWN_REASON)),
      this.writeIndicator("info.devicesOnline", 0),
      this.writeIndicator("info.devicesAllOnline", false),
      this.writeIndicator("info.connection", false),
    ]);
  }

  /**
   * The Rokus whose status datapoints hold a value — the only ones the start stamp touches, so it creates nothing a
   * tree does not have.
   *
   * @returns their id-safe device path segments
   */
  private storedStatusDevices(): string[] {
    const ids = new Set<string>();
    for (const id of this.lastState.keys()) {
      const parts = id.split(".");
      if (parts.length === 3 && parts[1] === "info" && (parts[2] === "online" || parts[2] === "error")) {
        ids.add(parts[0]);
      }
    }
    return [...ids];
  }

  /**
   * One-shot repair of this instance's own object — the settings keys and the leftover `common` keys.
   *
   * js-controller only ever ADDS to an existing instance object: on an update it fills missing
   * `native` keys with the manifest default, and a `common` key the manifest dropped stays behind
   * for ever. Two changes therefore never reached an existing installation on their own:
   * the listen address had to MOVE to `bind` (a read fallback finds the injected default, not the
   * user's value), and `license`/`singletonHost` stayed in the instance object (read by nobody:
   * `createInstance` reads the ADAPTER object, but a dead key is still the adapter's to remove).
   *
   * Everything goes through the fleet helper (`lib/native-key-migration.ts`, byte-identical with
   * the fleet master) in ONE write, so the update costs one restart: it merges only the touched
   * keys, and when the write fails it carries the migrated values into this run's config instead
   * of starting on the injected default.
   *
   * @returns true when the object was written — the caller aborts its start, the host restarts
   */
  private async repairInstanceObject(): Promise<boolean> {
    const id = instanceObjectId(this.namespace);
    let obj: { common?: Record<string, unknown>; native?: Record<string, unknown> } | null | undefined;
    try {
      obj = await this.getForeignObjectAsync(id);
    } catch (err) {
      this.log.warn(`Settings repair skipped — could not read ${id}: ${errText(err)}`);
      return false;
    }
    if (!obj) {
      return false;
    }
    return migrateNativeKeys(this, bindKeyMigrations(obj.native ?? {}), errText);
  }

  /** Create each device's object tree, start its ECP server, then the shared SSDP responder. */
  private async onReady(): Promise<void> {
    try {
      await I18n.init(join(this.adapterDir, "admin"), this);
      this.deviceManagement = new FakerokuDeviceManagement(this);

      // Repair what an update leaves behind in the instance object, before anything binds a port.
      // The write restarts this instance, so nothing may start before it.
      if (await this.repairInstanceObject()) {
        return;
      }

      await this.known.load();
      await this.primeStates();
      await this.markOffline(this.storedStatusDevices());
      await this.refreshOwnObjects();

      // The object tree as it is before this start touches it: the rows resolve their object id
      // and — for a row from before 0.7.0 — their type against it.
      const owned = await this.readOwnObjects();
      this.ownObjects = owned;
      if (this.stopping) {
        return;
      }

      // Read the device list BEFORE anything can return early: the orphan sweep below
      // has to know the configured set at every exit, or a tree the user just deleted
      // stays in the database for good (there is no second path that removes it).
      // `null` separates "the user removed the last device" (an empty array — sweep)
      // from "there is no devices key at all" (never configured, or a config we could
      // not read — sweep nothing, or we would delete a tree we cannot account for).
      // lib/device-config.ts is the ONE normaliser; the device manager reads the same
      // rows, so an edit can never resolve a different identity than the one advertised.
      const configured = toDeviceRows(
        this.config.devices,
        deviceTreeOf(owned.keys(), id => owned.get(id)?.type),
      );
      if (configured && (await this.persistDeviceRows(configured, owned))) {
        return;
      }

      // The fleet master reads "every address" ("", "0.0.0.0", "::" — instances from before 0.5.1 still carry ""):
      // then all interfaces are bound and every network is answered with the host's own address in it.
      this.bindIp = chosenAddress(this.config.bind);

      // A chosen interface is the user's decision: everything stays in its network. An address the host does not carry
      // (a new address from the router, a restored backup on other hardware) cannot be served — then the Rokus listen on
      // all addresses, so the remotes still find them, and the log says once what to fix.
      if (this.bindIp && !carriesAddress(this.bindIp)) {
        this.log.warn(
          `Address ${this.bindIp} does not exist on this host — listening on all addresses; choose another address in the instance settings`,
        );
        this.bindIp = undefined;
        this.bindMissing = true;
      }

      if (!configured || configured.length === 0) {
        // Yellow, not an exit: the device manager runs inside this process, and it is where a Roku is added.
        this.log.error("No Roku device configured — add one in the instance settings (device manager)");
        await this.sweepOrphans(configured);
        await this.updateConnection();
        return;
      }

      this.expectedDevices = configured.length;
      const failures = await this.startDevices(configured);
      if (this.stopping) {
        return;
      }
      await this.sweepOrphans(configured);
      if (this.stopping) {
        return;
      }
      this.reportFailures(failures);
      if (this.running.length > 0) {
        await this.startDiscovery();
        if (this.stopping) {
          return;
        }
        const of = this.running.length < this.expectedDevices ? ` of ${this.expectedDevices}` : "";
        const where = this.discoveryUp ? `advertising on ${this.advertisedAddresses()}` : "discovery unavailable";
        this.log.info(`Emulating ${this.running.length}${of} Roku device(s), ${where}`);
      }
      await this.updateConnection();
      this.scheduleRetry();
    } catch (e) {
      this.log.error(`onReady failed: ${errText(e)}`);
    }
  }

  /**
   * One line per Roku that does not run after the start — a warning while others run, and ONE error naming every Roku
   * and its reason when none runs. The instance stays up either way: the device manager runs inside it.
   *
   * @param failures the Rokus that do not run, with their reasons
   */
  private reportFailures(failures: readonly DeviceFailure[]): void {
    const retry = (f: DeviceFailure): string => (f.retried ? `; retrying every ${RETRY_INTERVAL_MS / 1000} s` : "");
    if (failures.length > 0 && this.running.length === 0) {
      const list = failures.map(f => `"${f.name}": ${f.reason}${retry(f)}`).join(" · ");
      this.log.error(`No emulated Roku is running — ${list}`);
      return;
    }
    for (const f of failures) {
      this.log.warn(`Emulated Roku "${f.name}" is not running — ${f.reason}${retry(f)}`);
    }
  }

  /**
   * The addresses discovery announces: the chosen one, or the host's own in every network it joins.
   *
   * @returns the addresses, comma-separated
   */
  private advertisedAddresses(): string {
    return (
      this.bindIp ??
      detectLocalIPv4s()
        .map(m => m.address)
        .join(", ")
    );
  }

  /**
   * The trust boundary of both services: a client in one of the host's own networks — with a
   * chosen interface only in that interface's network. Read fresh on every question, so an address
   * change is followed instead of frozen at start-up.
   *
   * @param address the client address
   * @returns true if the client may be answered
   */
  private readonly isOwnClient = (address: string | undefined): boolean => isOwnPeer(address, this.bindIp);

  /**
   * Create the object tree and start the ECP server for every configured device.
   *
   * Each device is isolated: a busy port, a reserved name or a colliding object id takes
   * down that device only. A device whose objects exist but whose server did not start goes
   * into {@link pending} and is retried — that case is a restart race far more often than a
   * real conflict, and without the retry the user has to restart the instance by hand.
   *
   * @param configured the normalised device rows
   * @returns the devices that do not run, with their reasons — the caller writes the lines about them
   */
  private async startDevices(configured: readonly DeviceRow[]): Promise<DeviceFailure[]> {
    const failures: DeviceFailure[] = [];
    const seenIds = new Set<string>();
    for (const row of configured) {
      // The host said stop: nothing more may start, and nothing may land in the queue onUnload
      // just emptied.
      if (this.stopping) {
        return failures;
      }
      const deviceId = row.objectId;
      // Two configured names can sanitize to the same object id — the admin guards
      // against it, but a hand-edited config could still carry it. Skip the duplicate
      // instead of letting two devices fight over one object tree.
      if (seenIds.has(deviceId)) {
        failures.push({ name: row.name, reason: `its object id ${deviceId} is already in use`, retried: false });
        continue;
      }
      // The dialog refuses these names, but native.devices is hand-editable. A
      // device called "info" would rewrite the adapter's own info channel into a
      // device object and hang its command/keys states under info.connection.
      if (RESERVED_IDS.has(deviceId)) {
        failures.push({
          name: row.name,
          reason: `its object id "${deviceId}" is reserved for the adapter's own status`,
          retried: false,
        });
        continue;
      }
      seenIds.add(deviceId);
      if (row.identityReplaced) {
        this.log.warn(`Emulated Roku "${row.name}" has an unusable device id in its config — using a derived one.`);
      }
      if (row.portReplaced) {
        this.log.warn(`Emulated Roku "${row.name}" has an unusable ECP port in its config — using ${row.port}.`);
      }
      const keys = keysForType(row.type);
      try {
        await this.createDeviceStates(deviceId, row.name, keys);
      } catch (e) {
        failures.push({ name: row.name, reason: `its objects could not be created: ${errText(e)}`, retried: false });
        continue;
      }
      const device: DeviceRuntime = {
        id: deviceId,
        name: row.name,
        advert: { uuid: row.identity, port: row.port },
        type: row.type,
        keys: new Set(keys),
      };
      this.devices.set(deviceId, device);
      const failed = await this.startDeviceServer(device);
      if (failed !== null && !this.stopping) {
        device.reason = failed;
        this.pending.push(device);
        failures.push({ name: row.name, reason: failed, retried: true });
      }
    }
    return failures;
  }

  /**
   * Start one device's ECP server and register it as running.
   *
   * @param device the device to start
   * @returns null when the server listens, else why it does not
   */
  private async startDeviceServer(device: DeviceRuntime): Promise<string | null> {
    // The host said stop while this device's objects were being created: bind nothing.
    if (this.stopping) {
      return "the adapter is stopping";
    }
    let server: EcpHttpServer | undefined;
    try {
      server = this.makeEcpServer({
        device: device.advert,
        friendlyName: device.name,
        deviceType: device.type,
        bindIp: this.bindIp,
        logger: this.log,
        onCommand: cmd => this.applyCommand(device.id, cmd),
        onFatalError: err => this.onEcpFatal(device, err),
        isClientAllowed: this.isOwnClient,
      });
      await server.start();
      // The host may have said stop while we were binding. Registering now would hand the
      // server to a device onUnload has already let go of — nothing would ever close it.
      if (this.stopping) {
        server.stop();
        return "the adapter is stopping";
      }
      device.server = server;
      this.ssdp?.addDevice(device.advert);
      return null;
    } catch (e) {
      // One device's failure (a busy ECP port) must not take the others down.
      // Close whatever the failed start left behind, so nothing outlives this turn.
      server?.stop();
      return listenFailure(e, device.advert.port);
    }
  }

  /** Arm the retry timer while a device is down or discovery is; a no-op otherwise. */
  private scheduleRetry(): void {
    const discoveryWanted = this.running.length > 0 && !this.ssdp;
    if (this.retryTimer || (this.pending.length === 0 && !discoveryWanted)) {
      return;
    }
    const timer = this.setTimeout(() => {
      this.retryTimer = undefined;
      void this.retryPendingDevices();
    }, RETRY_INTERVAL_MS);
    if (timer) {
      this.retryTimer = timer;
    }
  }

  /**
   * Try again what does not run: the devices whose server is down, then discovery. A port taken at boot is usually a
   * restart race — the previous process still holds it — so this recovers on its own instead of leaving a dead device
   * behind a yellow instance until someone restarts by hand. A retry that fails again says so on debug only; one that
   * succeeds says so once on info.
   */
  private async retryPendingDevices(): Promise<void> {
    // The timer drops this call with `void`, so nothing may escape it: a rejection here — the
    // status write failing while the states database hiccups — would be an unhandled rejection,
    // and js-controller ends the instance over it.
    try {
      // No stopping check at the entry: onUnload sets the flag and empties the queue in the
      // same synchronous block, so a call that arrives afterwards finds nothing to do, and a
      // call already inside the loop is caught after the bind and again at the tail.
      const stillPending: DeviceRuntime[] = [];
      for (const device of this.pending) {
        const failed = await this.startDeviceServer(device);
        if (failed === null) {
          this.log.info(`Emulated Roku "${device.name}" is listening on port ${device.advert.port} again.`);
        } else {
          this.log.debug(`Emulated Roku "${device.name}" still not running — ${failed}`);
          device.reason = failed;
          stillPending.push(device);
        }
      }
      if (this.stopping) {
        // The host said stop while we were binding. Assigning the list back would re-fill the
        // queue onUnload just emptied, and scheduleRetry would then arm a new timer —
        // which js-controller refuses during shutdown, with a warning nobody can explain.
        return;
      }
      this.pending = stillPending;
      // Discovery may never have started (every device failed at boot), or it went down.
      if (this.running.length > 0 && !this.ssdp) {
        await this.startDiscovery();
      }
      // A stop during the start above finds nothing to write: onUnload wrote false and emptied what the retry would arm.
      await this.updateConnection();
      this.scheduleRetry();
    } catch (e) {
      this.log.warn(`Retrying the emulated Rokus failed: ${errText(e)}`);
      // No stopping check: onUnload empties the queue, and scheduleRetry arms nothing for
      // an empty one.
      this.scheduleRetry();
    }
  }

  /**
   * Start the SSDP responder for the devices that are listening.
   *
   * Discovery is what lets a remote FIND an emulated Roku; a remote already paired keeps working without it. A busy port
   * 1900, a stuck bind or a host without an IPv4 therefore leaves the Rokus running and the instance yellow, and the
   * minute retry starts it again. In the auto case join every interface and answer each network with the host's own
   * address in it, so a multi-homed host is discoverable — and reachable — on all its LANs; a chosen interface pins
   * membership, NOTIFY egress and every answer to itself.
   */
  private async startDiscovery(): Promise<void> {
    // Both callers start it only while nothing runs and the host has not said stop.
    const bindIp = this.bindIp;
    const advertiseIp = bindIp ?? detectPrimaryIPv4();
    if (!advertiseIp) {
      this.discoveryFailed("the host has no IPv4 address");
      return;
    }
    const membershipInterfaces = bindIp
      ? [{ iface: localNets().find(net => net.address === bindIp)?.iface ?? bindIp, address: bindIp }]
      : detectLocalIPv4s();
    const ssdp = this.makeSsdpResponder({
      devices: [...this.running],
      bindIp,
      advertiseIp,
      membershipInterfaces,
      logger: this.log,
      isClientAllowed: this.isOwnClient,
      // "All interfaces": every search is answered with the host's address in the searcher's own
      // network. A chosen interface answers with its address only (the responder uses bindIp).
      advertiseFor: bindIp ? undefined : remote => localAddressFor(remote),
      onFatalError: err => this.onSsdpFatal(err),
    });
    this.ssdp = ssdp;
    try {
      await this.startWithTimeout(ssdp.start(), SSDP_START_TIMEOUT_MS);
    } catch (e) {
      // A start that only timed out can still bind later. Close it, or the socket
      // outlives the reference dropped here and keeps answering with nobody to stop it.
      ssdp.stop();
      if (this.ssdp === ssdp) {
        this.ssdp = undefined;
      }
      this.discoveryFailed(errText(e));
      return;
    }
    // The bind resolved after the host asked us to stop: announcing now would put a
    // device back into the network we just said goodbye to, and this.setInterval would
    // refuse with "setInterval called, but adapter is shutting down".
    if (this.stopping) {
      ssdp.stop();
      return;
    }
    this.discoveryUp = true;
    if (this.discoveryDown) {
      this.discoveryDown = false;
      this.log.info("SSDP discovery is running again — remotes can find the emulated Rokus.");
    }
    ssdp.announce();
    const timer = this.setInterval(() => this.announceTick(), SSDP_NOTIFY_INTERVAL_MS);
    if (timer) {
      this.notifyTimer = timer;
    }
  }

  /**
   * Discovery is down: one warning with the cause for the outage, its repeats on debug.
   *
   * @param cause why it is down
   */
  private discoveryFailed(cause: string): void {
    this.discoveryUp = false;
    if (this.discoveryDown) {
      this.log.debug(`SSDP discovery still unavailable: ${cause}`);
      return;
    }
    this.discoveryDown = true;
    this.log.warn(
      `SSDP discovery unavailable: ${cause} — paired remotes keep working, a new pairing does not; retrying every ${RETRY_INTERVAL_MS / 1000} s`,
    );
  }

  /**
   * One NOTIFY pass: follow the host first, then announce.
   *
   * Only in the automatic case — a chosen interface is the user's decision and does not move under
   * us. Every pass hands the responder the interfaces the host has NOW: one that came up since the
   * start (a second network card, a VLAN) is joined and announced on, one that went away is
   * dropped, and a changed fallback address (a DHCP lease change) is logged once. Every five
   * minutes is early enough: a controller caches the announced address for its max-age of an hour.
   */
  private announceTick(): void {
    if (!this.bindIp) {
      const current = detectPrimaryIPv4();
      if (current && this.ssdp?.refreshAdvertise(current, detectLocalIPv4s())) {
        this.log.info(`Host address changed — the emulated Rokus are now advertised on ${current}.`);
      }
    }
    this.ssdp?.announce();
  }

  /**
   * Re-apply the adapter's OWN objects — the `info` channel, `info.connection` and the three
   * device counts — on every start.
   *
   * js-controller extends the manifest's instanceObjects on every start, but it preserves
   * `common.name` of an existing object (7.2.2 `_extendObjects`, `preserve: { common: ["name"] }`):
   * a changed description or role arrives by itself, a changed NAME only on a fresh install.
   * extendObject is what carries the name into an existing tree, so an update always lands on
   * every datapoint, not just on fresh installs.
   *
   * Only name and description: the manifest owns the rest of the shape, and js-controller writes
   * it back on every start — the object type included (`extend(true, old, manifest)`), which is
   * also what repairs an `info` channel a hand-edited device row named "info" once turned into a
   * device object (see the reserved-id guard in startDevices). Each is written only when it
   * differs from the object as read at start.
   */
  private async refreshOwnObjects(): Promise<void> {
    const info = { common: { name: tName("channelInfo") } };
    if (!coveredBy(info, this.known.get("info"))) {
      await this.extendObject("info", info);
    }
    const connection = { common: { name: tName("connectionStatus"), desc: tDesc("connectionStatusDesc") } };
    if (!coveredBy(connection, this.known.get("info.connection"))) {
      await this.extendObject("info.connection", connection);
    }
    const devicesTotal = { common: { name: tName("devicesTotal"), desc: tDesc("devicesTotalDesc") } };
    if (!coveredBy(devicesTotal, this.known.get("info.devicesTotal"))) {
      await this.extendObject("info.devicesTotal", devicesTotal);
    }
    const devicesOnline = { common: { name: tName("devicesOnline"), desc: tDesc("devicesOnlineDesc") } };
    if (!coveredBy(devicesOnline, this.known.get("info.devicesOnline"))) {
      await this.extendObject("info.devicesOnline", devicesOnline);
    }
    const devicesAllOnline = { common: { name: tName("devicesAllOnline"), desc: tDesc("devicesAllOnlineDesc") } };
    if (!coveredBy(devicesAllOnline, this.known.get("info.devicesAllOnline"))) {
      await this.extendObject("info.devicesAllOnline", devicesAllOnline);
    }
  }

  /**
   * Create the fixed object tree for one emulated Roku: the device with its status symbol, its
   * `info.online` and `info.error`, `command`, and one `sensor` boolean state per key the device
   * type exposes — all up front, so the tree is usable before any key is ever pressed.
   *
   * Every key state is also RESET to false here. A key is a momentary signal, but
   * nothing writes its release when the adapter goes down: a keypress pulses true
   * and schedules the false 50 ms later, a keydown holds true until its keyup, and
   * onUnload drops both timers without writing. So a stop inside that window — or
   * a crash, or a controller that never sent its keyup — leaves the key true in
   * the database for good, and a rule watching for the next press never sees an
   * edge again. The reset belongs on STARTUP, not into onUnload: only startup also
   * covers the crash, and up to 31 writes per device would eat the shutdown budget that
   * today comfortably carries a single one. The reset compares against the values read in
   * the start's one bulk read and writes only a key that is not false — a healthy tree costs
   * no write and no read.
   *
   * The writes go out together: they address different objects, and doing them strictly
   * one after another would make start-up wait for one round trip per datapoint.
   *
   * @param deviceId the id-safe device path segment
   * @param friendlyName the configured device name
   * @param keys the key names to create for this device (from its type)
   */
  private async createDeviceStates(deviceId: string, friendlyName: string, keys: readonly string[]): Promise<void> {
    await Promise.all([
      // The device name is the user's own text — nothing to translate, but it must
      // still BE a translation object like every other common.name (tRaw).
      // The symbol in the object browser comes from statusStates; a relative id is read below the device itself.
      this.known.extend(deviceId, {
        type: "device",
        common: { name: tRaw(friendlyName), statusStates: { onlineId: "info.online" } },
        native: {},
      }),
      this.known.extend(`${deviceId}.info`, {
        type: "channel",
        common: { name: tName("channelDeviceInfo"), desc: tDesc("channelDeviceInfoDesc") },
        native: {},
      }),
      this.known.extend(`${deviceId}.info.online`, {
        type: "state",
        common: {
          name: tName("stateOnline"),
          desc: tDesc("stateOnlineDesc"),
          type: "boolean",
          role: "indicator.reachable",
          read: true,
          write: false,
          def: false,
        },
        native: {},
      }),
      this.known.extend(`${deviceId}.info.error`, {
        type: "state",
        common: {
          name: tName("stateError"),
          desc: tDesc("stateErrorDesc"),
          type: "string",
          role: "text",
          read: true,
          write: false,
          def: UNKNOWN_REASON,
        },
        native: {},
      }),
      this.known.extend(`${deviceId}.command`, {
        type: "state",
        common: {
          name: tName("stateLastCommand"),
          desc: tDesc("stateLastCommandDesc"),
          type: "string",
          role: "text",
          read: true,
          write: false,
          def: "",
        },
        native: {},
      }),
      this.known.extend(`${deviceId}.keys`, {
        type: "channel",
        common: { name: tName("channelKeys"), desc: tDesc("channelKeysDesc") },
        native: {},
      }),
      ...keys.map(key =>
        this.known.extend(`${deviceId}.keys.${key}`, {
          type: "state",
          // "sensor" = generic boolean read-only (active/inactive). The docs suggest
          // button.press for a keypress-as-state, but the repochecker requires button.press to
          // be read:false, write:true (config_StateRoles) — a key state is read-only, so
          // button.press fails with E1010; sensor is the gate-conformant fit.
          // The name is the ECP key identifier and identical in every language, but
          // it still has to BE a translation object (tRaw), never a bare string.
          // No desc: the key name already says everything there is to say. The
          // decision itself is recorded in test/self-explaining.json, where the
          // object-inventory gate reads it — silence has to be a decision, not a gap.
          common: { name: tRaw(key), type: "boolean", role: "sensor", read: true, write: false, def: false },
          native: {},
        }),
      ),
    ]);
    await Promise.all(
      keys
        .map(key => `${deviceId}.keys.${key}`)
        .filter(id => this.needsKeyReset(id))
        .map(id => this.resetKey(id)),
    );
  }

  /**
   * Whether a key state has to be written back to false at start: a key whose value from the bulk read is not false.
   * A key without any value is written only when its object already existed — js-controller seeds the value of a
   * newly created state from its `common.def`, and only where no value exists yet.
   *
   * @param id the key state id relative to the namespace
   * @returns true if the key needs the write
   */
  private needsKeyReset(id: string): boolean {
    const last = this.lastState.get(id);
    return last ? last.val !== false : this.ownObjects.has(id);
  }

  /**
   * Write one key state back to false and remember it.
   *
   * @param id the key state id relative to the namespace
   */
  private async resetKey(id: string): Promise<void> {
    await this.setState(id, { val: false, ack: true });
    this.lastState.set(id, { val: false, ack: true, q: 0 });
  }

  /**
   * Fill {@link lastState} with ONE bulk read of the adapter's own states.
   */
  private async primeStates(): Promise<void> {
    const states = await this.getStatesAsync(`${this.namespace}.*`);
    const prefix = `${this.namespace}.`;
    this.lastState.clear();
    for (const [id, state] of Object.entries(states)) {
      if (state) {
        this.lastState.set(id.slice(prefix.length), { val: state.val, ack: state.ack, q: state.q });
      }
    }
  }

  /**
   * Write a read-only indicator only when it differs from what it holds (`val` strictly, `ack`, `q` — the fields
   * js-controller's own changed-check compares). The one place `info.connection`, the device counts and every Roku's
   * status are written. The value is remembered before the write, so two calls in a row write once; a failed write is
   * forgotten again so the next call retries.
   *
   * @param id the state id relative to the namespace
   * @param val the value to show
   */
  private async writeIndicator(id: string, val: boolean | number | string): Promise<void> {
    const last = this.lastState.get(id);
    if (last && last.val === val && last.ack && !last.q) {
      return;
    }
    this.lastState.set(id, { val, ack: true, q: 0 });
    try {
      await this.setState(id, { val, ack: true });
    } catch (e) {
      this.lastState.delete(id);
      throw e;
    }
  }

  /**
   * Run the orphan sweep for the current configuration — from EVERY exit of
   * onReady, which is the point of it existing as its own method.
   *
   * Nothing else removes a device tree: on an exit without the sweep, a device the user
   * deleted in the admin (the manager writes an empty list for the last one) would keep its
   * datapoints forever. So the sweep runs whenever the configuration could be read.
   *
   * `configured === null` is that condition, and it is not pedantry: with no `devices`
   * key at all (a never-configured instance, or a config we could not read) an
   * empty set would mean "nothing is configured, delete everything" — trading a
   * tree that stays for a tree that is gone.
   *
   * @param configured the configured rows, or null when there is no readable list
   */
  private async sweepOrphans(configured: readonly DeviceRow[] | null): Promise<void> {
    if (!configured) {
      return;
    }
    await this.cleanupOrphans(new Set(configured.map(row => row.objectId)));
  }

  /**
   * The adapter's objects, keyed relative to the namespace.
   *
   * @returns the object dump
   */
  private async readOwnObjects(): Promise<Map<string, ioBroker.Object>> {
    const objects = await this.getAdapterObjectsAsync();
    const prefix = `${this.namespace}.`;
    const owned = new Map<string, ioBroker.Object>();
    for (const [id, obj] of Object.entries(objects)) {
      if (id.startsWith(prefix)) {
        owned.set(id.slice(prefix.length), obj);
      }
    }
    return owned;
  }

  /**
   * Write into the configuration what a row has to carry for good, once, before anything announces it.
   *
   * - A device that has never been announced gets its own identity. "Never announced" is a row without a stored
   *   `uuid` whose object tree does not exist yet: the manifest's default device of a fresh instance, or a hand-written
   *   row. Its identity would otherwise be derived from its name, and every installation — every instance on one host
   *   too — announcing a device called "Roku" would share one USN. A row whose tree exists has been announced, maybe
   *   paired, and keeps the identity it has.
   * - A row from before 0.7.0 carries no type. It is read from the tree once (TV keys there make it a TV) and then
   *   written, together with the port it runs on, so no later start derives it again.
   *
   * Every row is written with its object id. Writing `native` restarts the instance, so the start ends here when
   * something was written.
   *
   * @param rows the configured rows
   * @param owned the object tree as it is
   * @returns true when the config was written — the caller aborts its start
   */
  private async persistDeviceRows(
    rows: readonly DeviceRow[],
    owned: ReadonlyMap<string, ioBroker.Object>,
  ): Promise<boolean> {
    const fresh = rows.filter(row => row.identityDerived && !owned.has(row.objectId));
    const untyped = rows.filter(row => row.typeDerived);
    if (fresh.length === 0 && untyped.length === 0) {
      return false;
    }
    const devices = rows.map(row => ({
      name: row.storedName,
      port: row.port,
      type: row.type,
      uuid: fresh.includes(row) ? randomIdentity() : row.identity,
      objectId: row.objectId,
    }));
    try {
      await this.extendForeignObjectAsync(instanceObjectId(this.namespace), { native: { devices } });
    } catch (e) {
      // Not fatal: the device starts with what was derived, as before, and the next start writes it.
      this.log.warn(`The emulated Roku settings could not be completed (${errText(e)}) — trying again next start`);
      return false;
    }
    if (fresh.length > 0) {
      this.log.info(
        `New emulated Roku ${fresh.map(row => `"${row.name}"`).join(", ")} got its own network identity — the instance restarts once`,
      );
    }
    if (untyped.length > 0) {
      this.log.info(
        `Emulated Roku ${untyped.map(row => `"${row.name}" (${row.type})`).join(", ")} from a version before 0.7.0 now carries its type in the settings — the instance restarts once`,
      );
    }
    return true;
  }

  /**
   * Remove objects left over from an earlier version or config — the legacy
   * `apps` node, keys no longer standard, and whole device sub-trees no longer
   * configured (a renamed/removed device). The adapter otherwise only ever
   * creates objects, so without this the tree would accrete stale entries.
   *
   * The same pass also strips attributes an older version wrote into a state's `native`
   * and this one does not (see {@link pruneStateNative}) — the object dump is already in
   * hand here, so recognising them costs nothing.
   *
   * @param configuredDeviceIds the id-safe names of the currently configured devices
   */
  private async cleanupOrphans(configuredDeviceIds: ReadonlySet<string>): Promise<void> {
    // A dump read NOW, after this start created and renamed its objects: the native repair
    // below writes an object back whole, and a dump from before the start would write the
    // names and descriptions of the previous version back over the ones just set.
    const owned = await this.readOwnObjects();
    const keysByDevice = new Map([...this.devices.values()].map(d => [d.id, d.keys]));
    const toDelete = planObjectCleanup([...owned.keys()], configuredDeviceIds, keysByDevice);
    for (const id of toDelete) {
      await this.delObjectAsync(id, { recursive: true }).catch((e: unknown) => {
        this.log.debug(`cleanup: could not delete ${id}: ${errText(e)}`);
      });
    }
    if (toDelete.length > 0) {
      this.log.debug(`Removed ${toDelete.length} orphaned object(s) from an earlier version or config.`);
    }
    await this.pruneStateNative(owned, new Set(toDelete));
  }

  /**
   * Strip `native` attributes an earlier version wrote and this one no longer does.
   *
   * The pre-0.5.0 adapter created every key state with `native: { url: "keys/Home" }`.
   * `extendObject` cannot remove that: it merges, so an attribute only the stored object
   * carries survives every further update — and writing `null` would not delete it either,
   * it would store `null`. So an installation upgraded from <= 0.4.0 carries a dead
   * attribute on every key datapoint, and the adapter answers for its own datapoints.
   *
   * Removing one therefore rewrites the object in a single `setForeignObject`, handing back
   * exactly what was read with `native` emptied — `common` included, because that is where
   * `common.custom` lives, the user's own history/chart configuration.
   *
   * Not `delObject` + `extendObject`: `delObject` on a state ALSO deletes the state's value
   * and removes its id from every enum it belongs to — the recorded value and the room — and
   * the re-created object would come back carrying `common.def` as its value.
   * `setForeignObject` touches neither. (The discouraged call is
   * `setObject`, repochecker S5054, and only because a blind full write overwrites what the
   * user changed; writing back what was just read does not.)
   *
   * The write fails safely: if it does not happen, the attribute stays where it was and the
   * tree is exactly as before. The reason is in the log.
   *
   * @param owned the adapter's objects, keyed relative to the namespace
   * @param deleted the ids the sweep just removed — no point writing to those
   */
  private async pruneStateNative(
    owned: ReadonlyMap<string, ioBroker.Object>,
    deleted: ReadonlySet<string>,
  ): Promise<void> {
    const stale = planNativePrune(owned, deleted);
    for (const [id, obj] of stale) {
      try {
        // Non-recursive: a channel or device carrying the leftover keeps its children,
        // which are read and repaired on their own turn.
        // One write, never a delete plus a re-create: from/ts/user are left out so the
        // controller stamps the write freshly — it only adopts them when they are absent.
        const { from: _from, ts: _ts, user: _user, ...keep } = obj;
        // The cast only collapses the union: ioBroker.Object spans every object kind
        // (instance, host, enum, ...), while a write accepts device/channel/state/folder.
        // The shape is the one just read back, so nothing is asserted away here.
        await this.setForeignObject(`${this.namespace}.${id}`, {
          ...keep,
          native: {},
        } as
          | ioBroker.SettableDeviceObject
          | ioBroker.SettableChannelObject
          | ioBroker.SettableFolderObject
          | ioBroker.SettableStateObject);
      } catch (e: unknown) {
        this.log.debug(`cleanup: could not rewrite ${id}: ${errText(e)}`);
      }
    }
    if (stale.length > 0) {
      this.log.debug(`Removed a stale native attribute from ${stale.length} object(s) of an earlier version.`);
    }
  }

  /**
   * Apply a received ECP command to one emulated Roku — the wiring target of its ECP server.
   *
   * @param deviceId the id-safe device path segment
   * @param cmd the parsed ECP command
   * @returns true if the command was applied, false if the rate gate dropped it or the device is gone
   */
  private applyCommand(deviceId: string, cmd: CommandEvent): boolean {
    const device = this.devices.get(deviceId);
    return device ? this.commands.apply(device, cmd) : false;
  }

  /**
   * Fire-and-forget state write for the command hot path. The states exist (created
   * up front in createDeviceStates), so there is no read-before-write; a rejection —
   * the states database already closed while a remote still sends — is traced at
   * debug, because an unhandled one would crash the adapter over one lost keypress.
   *
   * @param id the state id relative to the namespace
   * @param val the value to write
   */
  private writeState(id: string, val: string | boolean): void {
    this.setState(id, { val, ack: true }).catch((e: unknown) => {
      this.log.debug(`State write ${id} failed: ${errText(e)}`);
    });
  }

  /**
   * One emulated Roku's ECP server died at runtime (a server error after a good start, e.g. the host lost its network).
   * That device answers nothing any more: the instance turns yellow, discovery stops pointing remotes at it, and the
   * minute retry brings it back like a port that was busy at start-up. The other devices keep running, and the one
   * line names the device and the cause.
   *
   * @param device the device whose server died
   * @param err the server error
   */
  private onEcpFatal(device: DeviceRuntime, err: Error): void {
    if (this.stopping) {
      return;
    }
    this.log.error(
      `Emulated Roku "${device.name}" stopped answering: ${errText(err)} — retrying every ${RETRY_INTERVAL_MS / 1000} s`,
    );
    // Close it before letting go of it: nothing else ever reaches it again, and in compact mode
    // the port would stay taken for the lifetime of the whole host process. stop() is
    // idempotent and safe on a dead server.
    device.server?.stop();
    device.server = undefined;
    device.reason = `stopped answering: ${errText(err)}`;
    this.ssdp?.removeDevice(device.advert.uuid);
    if (!this.pending.includes(device)) {
      this.pending.push(device);
    }
    this.scheduleRetry();
    this.updateConnection().catch((e: unknown) => {
      this.log.debug(`Connection state write failed: ${errText(e)}`);
    });
  }

  /**
   * The SSDP responder died at runtime (its socket closed after a good start). Stop announcing into the dead socket,
   * close what is left of it, and let the minute retry start discovery again; the ECP servers keep working, the
   * instance is yellow meanwhile.
   *
   * @param err why it died
   */
  private onSsdpFatal(err: Error): void {
    if (this.notifyTimer) {
      this.clearInterval(this.notifyTimer);
      this.notifyTimer = undefined;
    }
    this.ssdp?.stop();
    this.ssdp = undefined;
    if (this.stopping) {
      return;
    }
    this.discoveryFailed(errText(err));
    this.scheduleRetry();
    this.updateConnection().catch((e: unknown) => {
      this.log.debug(`Connection state write failed: ${errText(e)}`);
    });
  }

  /**
   * Bound await: reject if the SSDP start doesn't settle in time, so a stuck
   * port-1900 bind degrades to "discovery off" instead of hanging the adapter.
   *
   * @param promise the SSDP start promise
   * @param ms the timeout in milliseconds
   * @returns a promise that settles with the start result or a timeout error
   */
  private startWithTimeout(promise: Promise<void>, ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = this.setTimeout(() => reject(new Error(`SSDP start timed out after ${ms} ms`)), ms);
      const clear = (): void => {
        if (timer) {
          this.clearTimeout(timer);
        }
      };
      promise.then(
        () => {
          clear();
          resolve();
        },
        (e: unknown) => {
          clear();
          // Lint (prefer-promise-reject-errors) wants an Error here; errText downstream
          // would cope with anything, so this is the rule's shape, not a second safeguard.
          reject(e instanceof Error ? e : new Error(errText(e)));
        },
      );
    });
  }

  /**
   * Teardown: drop the timers and sockets synchronously, then report done only
   * once the farewell and the last write have landed.
   *
   * Nothing else resets this adapter's status — `info.connection`, every Roku's
   * `info.online` and `info.error`, the device counts: the host means to reset
   * `info.connection`, but writes its reset to the namespace root instead of the
   * datapoint (js-controller#3472), and it knows nothing of the rest. So if the
   * final writes are lost, the instance and every Roku show "running" while the
   * adapter is off.
   *
   * A fire-and-forget write plus an immediate callback is a race; waiting closes it for the
   * slow or busy case. It is safe because without `common.supportedMessages.stopInstance` the
   * host grants the full `common.stopTimeout` instead of killing the process.
   *
   * The farewell (`ssdp:byebye`) rides in the same wait: without it a controller keeps the
   * emulated Roku in its list for up to the announced hour and sends key presses into a
   * port nobody serves.
   *
   * @param callback function to invoke once teardown is complete
   */
  private onUnload(callback: () => void): void {
    try {
      // First of all, before any teardown: whatever is still in flight must not start or
      // write anything from here on.
      this.stopping = true;
      if (this.notifyTimer) {
        this.clearInterval(this.notifyTimer);
        this.notifyTimer = undefined;
      }
      if (this.retryTimer) {
        this.clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
      }
      this.commands.dispose();
      // The ECP servers close right here, synchronously: nothing about the farewell needs
      // them, and a keep-alive connection left open drags teardown toward a SIGKILL.
      for (const device of this.devices.values()) {
        device.server?.stop();
      }
      const marked = [...this.devices.keys()];
      this.devices.clear();
      this.pending = [];
      // The SSDP socket is the one thing that cannot close yet — the farewell goes out
      // through it. It is closed in the callback below, whichever way that arrives.
      const farewell = this.ssdp ? this.ssdp.byebye() : Promise.resolve();
      const status = this.markOffline(marked)
        // A rejected write must not become an unhandled rejection — that is a
        // crash (exit code 6) instead of an orderly stop. The trace stays at
        // debug: it explains a stale "connected" afterwards, and nobody can act
        // on it while the adapter is already going down.
        .catch((e: unknown) => {
          this.log.debug(`Final status write failed: ${errText(e)}`);
        });
      void Promise.all([farewell, status]).finally(() => {
        this.ssdp?.stop();
        this.ssdp = undefined;
        callback();
      });
    } catch {
      callback();
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Fakeroku(options);
} else {
  // Start the instance directly
  (() => new Fakeroku())();
}
