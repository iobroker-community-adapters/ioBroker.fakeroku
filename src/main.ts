import * as utils from "@iobroker/adapter-core";
import { I18n } from "@iobroker/adapter-core";
import { join } from "node:path";
import { FakerokuDeviceManagement } from "./device-management";
import type { RokuAdvert } from "./discovery/ssdp-messages";
import { DiscoveryLifecycle } from "./discovery/discovery-lifecycle";
import { RokuSsdpResponder } from "./discovery/ssdp-responder";
import { CommandHandler } from "./command-handler";
import type { CommandEvent } from "./ecp/ecp-command";
import { EcpHttpServer } from "./ecp/ecp-http-server";
import {
  DEVICE_ERROR_ID,
  DEVICE_ONLINE_ID,
  instanceObjectId,
  RESERVED_IDS,
  RETRY_INTERVAL_MS,
  RETRY_NOTE,
} from "./lib/constants";
import { deviceTreeOf, storedRowOf, toDeviceRows, type DeviceRow } from "./lib/device-config";
import { randomIdentity } from "./lib/device-identity";
import { detectLocalIPv4s } from "./lib/detect-ip";
import { deviceIcon } from "./lib/device-icons";
import { errText } from "./lib/err-text";
import { migrateNativeKeys, type NativeKeyMigration } from "./lib/native-key-migration";
import { type I18nKey, tDesc, tName, tRaw } from "./lib/i18n";
import { KnownObjects } from "./lib/known-objects";
import { carriesAddress, chosenAddress, isOwnPeer } from "./lib/network-address";
import { planNativePrune, planObjectCleanup } from "./lib/object-cleanup";
import { ownRelativeId } from "./lib/pure-helpers";
import { type DeviceType, keysForType } from "./lib/roku-keys";
import { StatusBoard, UNKNOWN_REASON } from "./status-board";

/**
 * The adapter's own objects with the translation keys of their name and description (none for the `info` channel) —
 * refreshed on every start by {@link Fakeroku.refreshOwnObjects}.
 */
const OWN_OBJECT_TEXTS: readonly (readonly [id: string, name: I18nKey, desc: I18nKey | undefined])[] = [
  ["info", "channelInfo", undefined],
  ["info.connection", "connectionStatus", "connectionStatusDesc"],
  ["info.devicesTotal", "devicesTotal", "devicesTotalDesc"],
  ["info.devicesOnline", "devicesOnline", "devicesOnlineDesc"],
  ["info.devicesAllOnline", "devicesAllOnline", "devicesAllOnlineDesc"],
];

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
class Fakeroku extends utils.Adapter {
  /** The SSDP side: the responder, its announcements, its outage and return, the farewell. */
  private readonly discovery = new DiscoveryLifecycle(this, {
    bindIp: () => this.bindIp,
    running: () => this.running,
    isClientAllowed: address => this.isOwnClient(address),
    stopping: () => this.stopping,
    makeSsdpResponder: options => this.makeSsdpResponder(options),
    onDown: () => {
      this.scheduleRetry();
      this.updateConnection().catch((e: unknown) => {
        this.log.debug(`Connection state write failed: ${errText(e)}`);
      });
    },
  });
  /** Every configured emulated Roku whose object tree this start created, by device id. */
  private readonly devices = new Map<string, DeviceRuntime>();
  /** Turns the remotes' commands into state writes. */
  private readonly commands = new CommandHandler({
    writeState: (id, val) => this.writeState(id, val),
    setTimeout: (callback, ms) => this.setTimeout(callback, ms),
    clearTimeout: timer => this.clearTimeout(timer),
    warn: message => this.log.warn(message),
  });
  /** The retry timer for {@link pending} and for discovery, armed only while something does not run. */
  private retryTimer: ioBroker.Timeout | undefined;
  /** A retry pass threw and the warning about it is written: repeats go to debug, the next good pass to info. */
  private retryBroken = false;

  /**
   * Set as the very first thing onUnload does. Everything that can still be in flight at
   * that moment asks it before it writes or starts anything: the minute retry can be sitting
   * in `await server.start()` when the host says stop, and would then register a server into
   * an already-cleared map and write info.connection TRUE after the closing FALSE.
   */
  private stopping = false;
  /** The read-only states this adapter writes outside the command hot path, each written only on a change. */
  private readonly status = new StatusBoard(this);
  /** The adapter's objects before this start created a device object — taken from {@link known}, keyed relative to the namespace. */
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
   * card or dialog text built before the translations are loaded throws. A `dm:*` message that arrives while
   * `I18n.init` still reads the translation files finds no listener yet: it gets no answer and no log line.
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
   * The devices whose ECP server is down — it did not start, or it died; retried on a timer until they come up.
   * onUnload lets go of every device, so nothing is pending once the host said stop.
   *
   * @returns the configured devices without a listening server
   */
  private get pending(): DeviceRuntime[] {
    return [...this.devices.values()].filter(d => !d.server);
  }

  /**
   * Green: everything runs — every configured Roku listens, discovery answers, the chosen address is the one in use.
   * Anything less is yellow (`info.connection` false) while the process keeps running, so the device manager stays
   * usable; red is only a process that is gone.
   *
   * @returns true when everything runs
   */
  private get healthy(): boolean {
    return this.allRunning && this.discovery.up && !this.bindMissing;
  }

  /**
   * Every configured Roku listens — the device half of {@link healthy}, and `info.devicesAllOnline`.
   *
   * @returns true when at least one Roku is configured and all of them listen
   */
  private get allRunning(): boolean {
    return this.expectedDevices > 0 && this.running.length === this.expectedDevices;
  }

  /**
   * Write what runs, in one pass from the same runtime state: every Roku's `info.online` and `info.error`, the three
   * device counts, and {@link healthy} to `info.connection` — each only on a change.
   *
   * @returns once the writes landed (or nothing had to be written)
   */
  private async updateConnection(): Promise<void> {
    await this.status.show({
      devices: [...this.devices.values()].map(device => [
        device.id,
        device.server ? "" : (device.reason ?? UNKNOWN_REASON),
      ]),
      total: this.expectedDevices,
      online: this.running.length,
      allOnline: this.allRunning,
      healthy: this.healthy,
    });
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
      await this.status.primeStates();
      await this.status.markOffline(this.status.storedStatusDevices());
      await this.refreshOwnObjects();

      if (this.stopping) {
        return;
      }
      // The object tree as it is before this start touches it: the rows resolve their object id
      // and — for a row from before 0.7.0 — their type against it.
      const owned = this.knownTree();
      this.ownObjects = owned;

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
        await this.discovery.startDiscovery();
        if (this.stopping) {
          return;
        }
        const of = this.running.length < this.expectedDevices ? ` of ${this.expectedDevices}` : "";
        const where = this.discovery.up ? `advertising on ${this.advertisedAddresses()}` : "discovery unavailable";
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
    const retry = (f: DeviceFailure): string => (f.retried ? `; ${RETRY_NOTE}` : "");
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
      // The host said stop: nothing more may start, and no device may land in the list onUnload
      // just let go of.
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
        await this.createDeviceStates(deviceId, row.name, row.type, keys);
      } catch (e) {
        failures.push({ name: row.name, reason: `its objects could not be created: ${errText(e)}`, retried: false });
        continue;
      }
      // The host said stop while the objects were being created: onUnload has let go of every device already.
      if (this.stopping) {
        return failures;
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
      // A stop during the bind needs no check here: onUnload let go of the device, and onReady stops right after.
      if (failed) {
        device.reason = failed;
        failures.push({ name: row.name, reason: failed, retried: true });
      }
    }
    return failures;
  }

  /**
   * Start one device's ECP server and register it as running.
   *
   * @param device the device to start
   * @returns null when the server listens, undefined when the host said stop (nothing bound, nothing to tell), else
   *   why it does not listen
   */
  private async startDeviceServer(device: DeviceRuntime): Promise<string | null | undefined> {
    // The host said stop before this retry reached the device: bind nothing.
    if (this.stopping) {
      return undefined;
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
        return undefined;
      }
      device.server = server;
      this.discovery.addDevice(device.advert);
      return null;
    } catch (e) {
      // One device's failure (a busy ECP port) must not take the others down.
      // Close whatever the failed start left behind, so nothing outlives this turn.
      server?.stop();
      return listenFailure(e, device.advert.port);
    }
  }

  /**
   * Arm the retry timer while a device is down or discovery is; a no-op otherwise — and once the host said stop, since
   * onUnload let go of every device.
   */
  private scheduleRetry(): void {
    const discoveryWanted = this.running.length > 0 && !this.discovery.started;
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
      // No stopping check at the entry: onUnload sets the flag and lets go of every device in the
      // same synchronous block, so a call that arrives afterwards finds nothing to do, and a
      // call already inside the loop is caught after the bind and again at the tail.
      for (const device of this.pending) {
        const failed = await this.startDeviceServer(device);
        if (failed === undefined) {
          return;
        }
        if (failed === null) {
          this.log.info(`Emulated Roku "${device.name}" is listening on port ${device.advert.port} again.`);
        } else {
          this.log.debug(`Emulated Roku "${device.name}" still not running — ${failed}`);
          device.reason = failed;
        }
      }
      if (this.stopping) {
        // The host said stop while we were binding: starting discovery or arming a new timer now would be refused by
        // js-controller during shutdown, with a warning nobody can explain.
        return;
      }
      // Discovery may never have started (every device failed at boot), or it went down.
      if (this.running.length > 0 && !this.discovery.started) {
        await this.discovery.startDiscovery();
      }
      // A stop during the start above finds nothing to write: onUnload wrote false and let go of every device.
      await this.updateConnection();
      if (this.retryBroken) {
        this.retryBroken = false;
        this.log.info("Retrying the emulated Rokus works again.");
      }
      this.scheduleRetry();
    } catch (e) {
      if (this.retryBroken) {
        this.log.debug(`Retrying the emulated Rokus failed again: ${errText(e)}`);
      } else {
        this.retryBroken = true;
        this.log.warn(`Retrying the emulated Rokus failed: ${errText(e)}`);
      }
      this.scheduleRetry();
    }
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
   * differs from the object as read at start ({@link KnownObjects.extend}).
   */
  private async refreshOwnObjects(): Promise<void> {
    for (const [id, name, desc] of OWN_OBJECT_TEXTS) {
      await this.known.extend(id, { common: { name: tName(name), ...(desc ? { desc: tDesc(desc) } : {}) } });
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
   * covers the crash, and up to 31 writes per device would eat the shutdown budget, which
   * already carries the status writes (two per Roku plus three, together and only where a
   * value changes). The reset compares against the values read in
   * the start's one bulk read and writes only a key that is not false — a healthy tree costs
   * no write and no read.
   *
   * The writes go out together: they address different objects, and doing them strictly
   * one after another would make start-up wait for one round trip per datapoint.
   *
   * @param deviceId the id-safe device path segment
   * @param friendlyName the configured device name
   * @param type the device type, which picks the pictogram of the device in the object browser
   * @param keys the key names to create for this device (from its type)
   */
  private async createDeviceStates(
    deviceId: string,
    friendlyName: string,
    type: DeviceType,
    keys: readonly string[],
  ): Promise<void> {
    await Promise.all([
      // The device name is the user's own text — nothing to translate, but it must
      // still BE a translation object like every other common.name (tRaw).
      // The online symbol in the object browser comes from statusStates; a relative id is read below the device
      // itself. The pictogram says player or TV; an unreadable file leaves the field as it is (undefined).
      this.known.extend(deviceId, {
        type: "device",
        common: { name: tRaw(friendlyName), icon: deviceIcon(type), statusStates: { onlineId: DEVICE_ONLINE_ID } },
        native: {},
      }),
      this.known.extend(`${deviceId}.info`, {
        type: "channel",
        common: { name: tName("channelDeviceInfo"), desc: tDesc("channelDeviceInfoDesc") },
        native: {},
      }),
      this.known.extend(`${deviceId}.${DEVICE_ONLINE_ID}`, {
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
      this.known.extend(`${deviceId}.${DEVICE_ERROR_ID}`, {
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
    const last = this.status.stored(id);
    return last ? last.val !== false : this.ownObjects.has(id);
  }

  /**
   * Write one key state back to false and remember it.
   *
   * @param id the key state id relative to the namespace
   */
  private async resetKey(id: string): Promise<void> {
    await this.setState(id, { val: false, ack: true });
    this.status.remember(id, false);
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
   * The adapter's objects as the store knows them now — the one read at start plus every write since — keyed relative
   * to the namespace. No second read of the tree.
   *
   * @returns the objects
   */
  private knownTree(): Map<string, ioBroker.Object> {
    const tree = new Map<string, ioBroker.Object>();
    for (const id of this.known.ids()) {
      tree.set(ownRelativeId(this.namespace, id) ?? id, this.known.get(id) as ioBroker.Object);
    }
    return tree;
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
    const devices = rows.map(row => storedRowOf(row, fresh.includes(row) ? randomIdentity() : row.identity));
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
    // The tree as it is NOW, after this start created and renamed its objects: the native repair
    // below writes an object back whole, and the tree from before the start would write the
    // names and descriptions of the previous version back over the ones just set.
    const owned = this.knownTree();
    const keysByDevice = new Map([...this.devices.values()].map(d => [d.id, d.keys]));
    const toDelete = planObjectCleanup([...owned.keys()], configuredDeviceIds, keysByDevice);
    for (const id of toDelete) {
      await this.known.remove(id, { recursive: true }).catch((e: unknown) => {
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
        await this.known.replace(`${this.namespace}.${id}`, {
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
    this.log.error(`Emulated Roku "${device.name}" stopped answering: ${errText(err)} — ${RETRY_NOTE}`);
    // Close it before letting go of it: nothing else ever reaches it again, and in compact mode
    // the port would stay taken for the lifetime of the whole host process. stop() is
    // idempotent and safe on a dead server.
    device.server?.stop();
    device.server = undefined;
    device.reason = `stopped answering: ${errText(err)}`;
    this.discovery.removeDevice(device.advert.uuid);
    this.scheduleRetry();
    this.updateConnection().catch((e: unknown) => {
      this.log.debug(`Connection state write failed: ${errText(e)}`);
    });
  }

  /**
   * Teardown: drop the timers and sockets synchronously, then report done only
   * once the farewell and the last write have landed.
   *
   * Nothing else resets every Roku's `info.online` and `info.error` and the device
   * counts: the host resets only `info.connection` (js-controller#3472, fixed in 7.2.3)
   * and knows nothing of the rest. So if the final writes are lost, every Roku shows
   * "running" while the adapter is off.
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
      this.discovery.stopAnnouncing();
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
      // The SSDP socket is the one thing that cannot close yet — the farewell goes out
      // through it. It is closed in the callback below, whichever way that arrives.
      const farewell = this.discovery.byebye();
      const status = this.status
        .markOffline(marked)
        // A rejected write must not become an unhandled rejection — that is a
        // crash (exit code 6) instead of an orderly stop. The trace stays at
        // debug: it explains a stale "connected" afterwards, and nobody can act
        // on it while the adapter is already going down.
        .catch((e: unknown) => {
          this.log.debug(`Final status write failed: ${errText(e)}`);
        });
      void Promise.all([farewell, status]).finally(() => {
        this.discovery.stop();
        callback();
      });
    } catch {
      callback();
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode; the class rides along on the factory for the tests (an `export` next
  // to `module.exports` makes esbuild treat the file as an ES module)
  module.exports = Object.assign((options: Partial<utils.AdapterOptions> | undefined) => new Fakeroku(options), {
    Fakeroku,
  });
} else {
  // Start the instance directly
  (() => new Fakeroku())();
}
