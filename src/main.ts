import * as utils from "@iobroker/adapter-core";
import { I18n } from "@iobroker/adapter-core";
import { join } from "node:path";
import { FakerokuDeviceManagement } from "./device-management";
import type { RokuAdvert } from "./discovery/ssdp-messages";
import { RokuSsdpResponder } from "./discovery/ssdp-responder";
import { DEFAULT_APPS } from "./ecp/device-info";
import { COMMAND_TYPES, type CommandEvent } from "./ecp/ecp-command";
import { EcpHttpServer } from "./ecp/ecp-http-server";
import { commandToStateWrite, type DeviceType, keysForType } from "./ecp/state-model";
import { RESERVED_IDS } from "./lib/constants";
import { deviceObjectId, toDeviceRows, type DeviceRow } from "./lib/device-config";
import { detectLocalIPv4s, detectPrimaryIPv4 } from "./lib/detect-ip";
import { errText } from "./lib/errors";
import { tDesc, tName, tRaw } from "./lib/i18n";
import { planNativePrune, planObjectCleanup } from "./lib/object-cleanup";
import { RateGate } from "./lib/rate-gate";

/** Managed timeout for a stuck SSDP start (a busy port 1900 must not hang onReady). */
const SSDP_START_TIMEOUT_MS = 5000;
/** Proactive ssdp:alive interval so controllers find the device without searching. */
const SSDP_NOTIFY_INTERVAL_MS = 300_000;
/** How long a keypress pulses its keys.<Key> state true before falling back to false. */
const KEY_PULSE_MS = 50;
/** Safety cap for a held key: a keydown with no matching keyup resets after this. */
const HOLD_MAX_MS = 30_000;
/** Commands accepted per second and emulated Roku; the excess is dropped (see lib/rate-gate.ts). */
const MAX_COMMANDS_PER_SECOND = 25;
/** How often at most the dropped-commands warning repeats per device. */
const RATE_WARN_INTERVAL_MS = 60_000;
/** How long to wait before trying a device whose ECP port was busy at start-up again. */
const DEVICE_RETRY_INTERVAL_MS = 60_000;

/** An emulated Roku whose ECP server did not come up yet — its objects exist, only the server is missing. */
interface PendingDevice {
  /** The id-safe device path segment. */
  deviceId: string;
  /** The configured device name, for log lines the user can act on. */
  friendlyName: string;
  /** The advert (identity + port) this device would answer under. */
  advert: RokuAdvert;
  /** The emulated device type. */
  deviceType: DeviceType;
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
  private readonly ecpServers = new Map<string, EcpHttpServer>();
  private readonly pulseTimers = new Set<ioBroker.Timeout>();
  /** Per held key id, its watchdog timer — so a keydown without a keyup cannot pin it true forever. */
  private readonly holdTimers = new Map<string, ioBroker.Timeout>();
  /** Per device, the key names it exposes — so a keypress only writes keys this device carries. */
  private readonly deviceKeys = new Map<string, ReadonlySet<string>>();
  /** Per device, its command rate gate — the write-flood protection for the states database. */
  private readonly commandGates = new Map<string, RateGate>();
  /** Per device, when the dropped-commands warning was last written. */
  private readonly rateWarnedAt = new Map<string, number>();
  /** The devices that are actually listening — the basis for info.connection. */
  private readonly running: RokuAdvert[] = [];
  /** Devices whose ECP server did not start; retried on a timer until they come up. */
  private pending: PendingDevice[] = [];
  /** The retry timer for {@link pending}, armed only while something is waiting. */
  private retryTimer: ioBroker.Timeout | undefined;
  /** How many configured devices are expected to listen — the target info.connection compares against. */
  private expectedDevices = 0;
  /** The interface to bind to, or undefined for "all" — kept for the retry after onReady returned. */
  private bindIp: string | undefined;
  /**
   * Device-manager backend: the emulated Rokus as cards with add/edit/delete.
   *
   * Nothing reads this field, and that is not an oversight: dm-utils subscribes to
   * the adapter's `message` event from its own constructor, so creating the object
   * IS the wiring. The field keeps it visible — and owned — instead of leaving a
   * bare `new` in the constructor that reads like a mistake.
   */
  private readonly deviceManagement: FakerokuDeviceManagement;

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
    this.deviceManagement = new FakerokuDeviceManagement(this);
  }

  /** Create each device's object tree, start its ECP server, then the shared SSDP responder. */
  private async onReady(): Promise<void> {
    try {
      await this.setState("info.connection", { val: false, ack: true });
      await I18n.init(join(this.adapterDir, "admin"), this);
      await this.refreshOwnObjects();

      // Read the device list BEFORE anything can return early: the orphan sweep below
      // has to know the configured set at every exit, or a tree the user just deleted
      // stays in the database for good (there is no second path that removes it).
      // `null` separates "the user removed the last device" (an empty array — sweep)
      // from "there is no devices key at all" (never configured, or a config we could
      // not read — sweep nothing, or we would delete a tree we cannot account for).
      // lib/device-config.ts is the ONE normaliser; the device manager reads the same
      // rows, so an edit can never resolve a different identity than the one advertised.
      const configured = toDeviceRows(this.config.devices);

      // Empty AND "0.0.0.0" both mean "auto": bind all interfaces, advertise the
      // detected primary IP so the adapter runs without configuration. js-controller
      // never rewrites an existing native default, so instances from before 0.5.1
      // still carry "" — both must take the auto path. A concrete IP is honoured as-is.
      // Migration: a pre-0.5.0 instance has no `networkInterface`, only the old `BIND` —
      // adopt it so a multi-homed host keeps the interface the user had configured.
      const configuredIp = this.config.networkInterface || this.config.BIND;
      this.bindIp = configuredIp && configuredIp !== "0.0.0.0" ? configuredIp : undefined;
      const advertiseIp = this.bindIp ?? detectPrimaryIPv4();
      if (!advertiseIp) {
        this.log.warn("No routable IPv4 address found to advertise — set the network interface in the settings.");
        // Sweep even here: what belongs in the tree is decided by the configuration,
        // not by the network. A missing cable is no reason to keep a deleted device.
        await this.sweepOrphans(configured);
        return;
      }

      if (!configured || configured.length === 0) {
        this.log.warn("No emulated Roku devices configured.");
        await this.sweepOrphans(configured);
        return;
      }

      this.expectedDevices = configured.length;
      await this.startDevices(configured);
      await this.sweepOrphans(configured);

      if (this.running.length === 0 && this.pending.length === 0) {
        // Nothing is controllable and nothing is worth retrying — leave info.connection false.
        this.log.error("No emulated Roku device could be started — check the configured names for conflicts.");
        return;
      }

      if (this.running.length > 0) {
        this.startDiscovery(advertiseIp);
      }
      await this.reportConnectionState(advertiseIp);
      this.scheduleDeviceRetry();
    } catch (e) {
      this.log.error(`onReady failed: ${errText(e)}`);
    }
  }

  /**
   * Create the object tree and start the ECP server for every configured device.
   *
   * Each device is isolated: a busy port, a reserved name or a colliding object id takes
   * down that device only. A device whose objects exist but whose server did not start goes
   * into {@link pending} and is retried — that case is a restart race far more often than a
   * real conflict, and without the retry the user has to restart the instance by hand.
   *
   * @param configured the normalised device rows
   */
  private async startDevices(configured: readonly DeviceRow[]): Promise<void> {
    const seenIds = new Set<string>();
    for (const row of configured) {
      const deviceId = deviceObjectId(row);
      // Two configured names can sanitize to the same object id — the admin guards
      // against it, but a hand-edited config could still carry it. Skip the duplicate
      // instead of letting two devices fight over one object tree.
      if (seenIds.has(deviceId)) {
        this.log.warn(`Emulated Roku "${row.name}" maps to an object id already in use (${deviceId}) — skipping it.`);
        continue;
      }
      // The dialog refuses these names, but native.devices is hand-editable. A
      // device called "info" would rewrite the adapter's own info channel into a
      // device object and hang its command/keys states under info.connection.
      if (RESERVED_IDS.has(deviceId)) {
        this.log.warn(
          `Emulated Roku "${row.name}" maps to the object id "${deviceId}", which the adapter reserves for its own status — skipping it.`,
        );
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
        this.log.warn(`Emulated Roku "${row.name}" could not be created: ${errText(e)} — skipping it.`);
        continue;
      }
      this.deviceKeys.set(deviceId, new Set(keys));
      const device: PendingDevice = {
        deviceId,
        friendlyName: row.name,
        advert: { uuid: row.identity, port: row.port },
        deviceType: row.type,
      };
      if (!(await this.startDeviceServer(device, "start"))) {
        this.pending.push(device);
      }
    }
  }

  /**
   * Start one device's ECP server and register it as running.
   *
   * @param device the device to start
   * @param phase whether this is the initial start (warn) or a retry (debug — the warning was written once)
   * @returns true if the server is listening
   */
  private async startDeviceServer(device: PendingDevice, phase: "start" | "retry"): Promise<boolean> {
    let server: EcpHttpServer | undefined;
    try {
      server = this.makeEcpServer({
        device: device.advert,
        friendlyName: device.friendlyName,
        apps: DEFAULT_APPS,
        deviceType: device.deviceType,
        bindIp: this.bindIp,
        logger: this.log,
        onCommand: cmd => this.applyCommand(device.deviceId, cmd),
        onFatalError: () => this.onEcpFatal(device),
      });
      await server.start();
      this.ecpServers.set(device.deviceId, server);
      this.running.push(device.advert);
      this.ssdp?.addDevice(device.advert);
      if (phase === "retry") {
        this.log.info(`Emulated Roku "${device.friendlyName}" is listening on port ${device.advert.port} again.`);
      }
      return true;
    } catch (e) {
      // One device's failure (a busy ECP port) must not take the others down.
      // Close whatever the failed start left behind, so nothing outlives this turn.
      server?.stop();
      const detail = `${errText(e)} — retrying every ${DEVICE_RETRY_INTERVAL_MS / 1000} s`;
      if (phase === "start") {
        this.log.warn(
          `Emulated Roku "${device.friendlyName}" could not start on port ${device.advert.port}: ${detail}`,
        );
      } else {
        this.log.debug(
          `Emulated Roku "${device.friendlyName}" still cannot start on port ${device.advert.port}: ${detail}`,
        );
      }
      return false;
    }
  }

  /** Arm the retry timer while any device is still waiting for its port; a no-op otherwise. */
  private scheduleDeviceRetry(): void {
    if (this.retryTimer || this.pending.length === 0) {
      return;
    }
    const timer = this.setTimeout(() => {
      this.retryTimer = undefined;
      void this.retryPendingDevices();
    }, DEVICE_RETRY_INTERVAL_MS);
    if (timer) {
      this.retryTimer = timer;
    }
  }

  /**
   * Try the devices that could not start yet. A port taken at boot is usually a restart
   * race — the previous process still holds it — so this recovers on its own instead of
   * leaving a dead device behind a red instance until someone restarts by hand.
   */
  private async retryPendingDevices(): Promise<void> {
    const stillPending: PendingDevice[] = [];
    let recovered = false;
    for (const device of this.pending) {
      if (await this.startDeviceServer(device, "retry")) {
        recovered = true;
      } else {
        stillPending.push(device);
      }
    }
    this.pending = stillPending;
    if (recovered) {
      // Discovery may never have started (every device failed at boot) — bring it up now.
      const advertiseIp = this.bindIp ?? detectPrimaryIPv4();
      if (advertiseIp && !this.ssdp) {
        this.startDiscovery(advertiseIp);
      }
      await this.reportConnectionState(advertiseIp);
    }
    this.scheduleDeviceRetry();
  }

  /**
   * Start the SSDP responder for the devices that are listening.
   *
   * Discovery is only an aid; the ECP servers already make the adapter controllable, so a
   * busy port 1900 (or a stuck bind) degrades to "discovery off, already-paired remotes
   * still work" instead of failing the whole start-up. In the auto case join every routable
   * interface so a multi-homed host is discoverable on all its LANs; a chosen interface pins
   * both membership and NOTIFY egress.
   *
   * @param advertiseIp the routable IP to announce
   */
  private startDiscovery(advertiseIp: string): void {
    const membershipInterfaces = this.bindIp ? [this.bindIp] : detectLocalIPv4s();
    const ssdp = this.makeSsdpResponder({
      devices: [...this.running],
      bindIp: this.bindIp,
      advertiseIp,
      membershipInterfaces,
      logger: this.log,
      onFatalError: () => this.onSsdpFatal(),
    });
    this.ssdp = ssdp;
    this.startWithTimeout(ssdp.start(), SSDP_START_TIMEOUT_MS).then(
      () => {
        ssdp.announce();
        const timer = this.setInterval(() => this.ssdp?.announce(), SSDP_NOTIFY_INTERVAL_MS);
        if (timer) {
          this.notifyTimer = timer;
        }
      },
      (e: unknown) => {
        this.log.warn(
          `SSDP discovery unavailable: ${errText(e)} — already-paired remotes still work; set the network interface if devices are not found.`,
        );
        // A start that only timed out can still bind later. Close it, or the socket
        // outlives the reference dropped here and keeps answering with nobody to stop it.
        ssdp.stop();
        if (this.ssdp === ssdp) {
          this.ssdp = undefined;
        }
      },
    );
  }

  /**
   * Write info.connection and say in the log what the instance is doing.
   *
   * "Connected" means EVERY configured Roku is listening, not just some of them. A device
   * whose port is taken (or whose name collides) is skipped with a warning naming it;
   * reporting "connected" anyway would hide a broken configuration behind the devices that
   * did come up, and the user would only find out when the remote stops working. Config rows
   * without a usable name are filtered out before this point and deliberately do not count —
   * every device that fails has said so in the log.
   *
   * @param advertiseIp the announced IP, for the log line
   */
  private async reportConnectionState(advertiseIp: string): Promise<void> {
    const allStarted = this.running.length === this.expectedDevices;
    await this.setState("info.connection", { val: allStarted, ack: true });
    const where = `advertising on ${advertiseIp}${this.ssdp ? "" : " (discovery off)"}`;
    if (allStarted) {
      this.log.info(`Emulating ${this.running.length} Roku device(s), ${where}`);
    } else {
      this.log.error(
        `Only ${this.running.length} of ${this.expectedDevices} configured Roku device(s) could be started, ${where} — fix the cause reported above; the instance stays disconnected until every device runs.`,
      );
    }
  }

  /**
   * Re-apply the adapter's OWN objects — the `info` channel and `info.connection`
   * — on every start.
   *
   * js-controller creates the manifest's instanceObjects only where they are
   * missing, so a changed name or description never reaches an installation that
   * already has them: the manifest would be correct and the real tree unchanged.
   * extendObject is what carries the change into an existing tree, so an update
   * always lands on every datapoint, not just on fresh installs.
   *
   * It also repairs the `info` channel after a hand-edited device row named
   * "info" turned it into a device object (see the reserved-id guard in startDevices).
   */
  private async refreshOwnObjects(): Promise<void> {
    await Promise.all([
      this.extendObject("info", {
        type: "channel",
        common: { name: tName("channelInfo") },
        native: {},
      }),
      this.extendObject("info.connection", {
        type: "state",
        common: {
          name: tName("connectionStatus"),
          desc: tDesc("connectionStatusDesc"),
          type: "boolean",
          role: "indicator.connected",
          read: true,
          write: false,
          def: false,
        },
        native: {},
      }),
    ]);
  }

  /**
   * Create the fixed object tree for one emulated Roku: the device, `command` +
   * `commandType`, and one `sensor` boolean state per key the device type exposes —
   * all up front, so the tree is usable before any key is ever pressed.
   *
   * Every key state is also RESET to false here. A key is a momentary signal, but
   * nothing writes its release when the adapter goes down: a keypress pulses true
   * and schedules the false 50 ms later, a keydown holds true until its keyup, and
   * onUnload drops both timers without writing. So a stop inside that window — or
   * a crash, or a controller that never sent its keyup — leaves the key true in
   * the database for good, and a rule watching for the next press never sees an
   * edge again. The reset belongs on STARTUP, not into onUnload: only startup also
   * covers the crash, and 27 writes per device would eat the shutdown budget that
   * today comfortably carries a single one. setStateChanged writes only where the
   * value actually differs, so a healthy tree costs nothing.
   *
   * The writes go out together: they address different objects, and doing 20 (a player)
   * or 31 (a TV) of them strictly one after another made start-up wait for one round trip
   * per datapoint — the key reset right below has always been parallel.
   *
   * @param deviceId the id-safe device path segment
   * @param friendlyName the configured device name
   * @param keys the key names to create for this device (from its type)
   */
  private async createDeviceStates(deviceId: string, friendlyName: string, keys: readonly string[]): Promise<void> {
    await Promise.all([
      // The device name is the user's own text — nothing to translate, but it must
      // still BE a translation object like every other common.name (tRaw).
      this.extendObject(deviceId, { type: "device", common: { name: tRaw(friendlyName) }, native: {} }),
      this.extendObject(`${deviceId}.command`, {
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
      this.extendObject(`${deviceId}.commandType`, {
        type: "state",
        common: {
          name: tName("stateLastCommandType"),
          desc: tDesc("stateLastCommandTypeDesc"),
          type: "string",
          role: "text",
          read: true,
          write: false,
          def: "",
          // The fixed verb list, so the admin shows the value as a label. Plain strings
          // only — a translation object here crashes the admin's object view.
          states: Object.fromEntries(COMMAND_TYPES.map(verb => [verb, verb])),
        },
        native: {},
      }),
      this.extendObject(`${deviceId}.keys`, {
        type: "channel",
        common: { name: tName("channelKeys"), desc: tDesc("channelKeysDesc") },
        native: {},
      }),
      ...keys.map(key =>
        this.extendObject(`${deviceId}.keys.${key}`, {
          type: "state",
          // "sensor" = generic boolean read-only (active/inactive). The docs suggest
          // button.press for a keypress-as-state, but the repochecker rejects it
          // (E1010 — not in its role list); sensor is the gate-conformant fit.
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
    await Promise.all(keys.map(key => this.setStateChangedAsync(`${deviceId}.keys.${key}`, { val: false, ack: true })));
  }

  /**
   * Run the orphan sweep for the current configuration — from EVERY exit of
   * onReady, which is the point of it existing as its own method.
   *
   * The sweep used to sit on the happy path only, so removing the last emulated
   * Roku (or a host without a routable address) left its device object, its
   * `command` / `commandType` and its 16–27 key states behind with nothing that
   * would ever remove them: the user deletes a device in the admin and keeps its
   * datapoints forever. The adapter answers for its own datapoints
   * (`feedback_adapter_verantwortet_datenpunkte`), so the sweep runs whenever the
   * configuration could be read.
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
    await this.cleanupOrphans(new Set(configured.map(row => deviceObjectId(row))));
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
    const objects = await this.getAdapterObjectsAsync();
    const prefix = `${this.namespace}.`;
    const owned = new Map<string, ioBroker.Object>();
    for (const [id, obj] of Object.entries(objects)) {
      if (id.startsWith(prefix)) {
        owned.set(id.slice(prefix.length), obj);
      }
    }
    const toDelete = planObjectCleanup([...owned.keys()], configuredDeviceIds, this.deviceKeys);
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
   * Removing one therefore takes the object away and puts it back: `delObject` followed by
   * `extendObject`, the two methods the ioBroker standard blesses for this (a plain full
   * write is discouraged — it overwrites whatever the user changed). Which is why this is
   * careful: the object goes back exactly as it was read, `common` included — that is where
   * `common.custom` lives, the user's own history/chart configuration. Losing it would cost
   * far more than the leftover.
   *
   * Both halves fail safely. A delete that does not happen leaves the attribute where it
   * was — the tree is exactly as before. A re-create that does not happen leaves the object
   * gone until the next start, which creates it again from the configuration. Either way the
   * reason is in the log.
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
        await this.delObjectAsync(id);
        await this.extendObject(id, { ...obj, native: {} });
      } catch (e: unknown) {
        this.log.debug(`cleanup: could not rewrite ${id}: ${errText(e)}`);
      }
    }
    if (stale.length > 0) {
      this.log.debug(`Removed a stale native attribute from ${stale.length} object(s) of an earlier version.`);
    }
  }

  /**
   * Apply a received ECP command to this device's states: record it in `command`
   * / `commandType`, and pulse or hold the standard key if it is one.
   *
   * Returns whether the command was applied: the ECP server logs only what got
   * through, so the rate gate covers the log as well as the states database.
   *
   * @param deviceId the id-safe device path segment
   * @param cmd the parsed ECP command
   * @returns true if the command was applied, false if the rate gate dropped it
   */
  private applyCommand(deviceId: string, cmd: CommandEvent): boolean {
    const write = commandToStateWrite(cmd);
    // A key RELEASE never passes through the rate gate. Dropping a keypress costs one
    // event; dropping the keyup leaves the key true until the 30 s watchdog, so the flood
    // protection would be the thing that falsifies the tree. It also costs one write
    // instead of four, so it is not what the gate exists to stop.
    const isRelease = write.holdKey?.value === false;
    if (!isRelease && !this.admitCommand(deviceId)) {
      return false;
    }
    this.writeState(`${deviceId}.command`, write.command);
    this.writeState(`${deviceId}.commandType`, write.commandType);
    // Only write keys.<Key> if THIS device's type carries the key — a player has no
    // TV key objects, so a stray TV keypress lands in `command` only, never a missing state.
    const keys = this.deviceKeys.get(deviceId);
    if (write.pulseKey && keys?.has(write.pulseKey)) {
      const id = `${deviceId}.keys.${write.pulseKey}`;
      // A keypress on a key that is currently HELD ends the hold: its watchdog would
      // otherwise fire later and write a release for a key the pulse already released.
      this.clearHoldTimer(id);
      this.writeState(id, true);
      const timer = this.setTimeout(() => {
        if (timer) {
          this.pulseTimers.delete(timer);
        }
        this.writeState(id, false);
      }, KEY_PULSE_MS);
      if (timer) {
        this.pulseTimers.add(timer);
      }
    } else if (write.holdKey && keys?.has(write.holdKey.key)) {
      const id = `${deviceId}.keys.${write.holdKey.key}`;
      this.writeState(id, write.holdKey.value);
      // A keydown holds the key true until its keyup. Arm a watchdog so a lost keyup
      // (controller disconnects mid-press) cannot pin the key true forever; a keyup
      // clears it, and a repeated keydown re-arms it.
      this.clearHoldTimer(id);
      if (write.holdKey.value) {
        const timer = this.setTimeout(() => {
          this.holdTimers.delete(id);
          this.writeState(id, false);
        }, HOLD_MAX_MS);
        if (timer) {
          this.holdTimers.set(id, timer);
        }
      }
    }
    return true;
  }

  /**
   * Disarm the hold watchdog of one key, if it has one.
   *
   * @param id the full key state id
   */
  private clearHoldTimer(id: string): void {
    const pending = this.holdTimers.get(id);
    if (pending) {
      this.clearTimeout(pending);
      this.holdTimers.delete(id);
    }
  }

  /**
   * The rate gate in front of every state write: MAX_COMMANDS_PER_SECOND per device,
   * the excess is dropped and reported once per RATE_WARN_INTERVAL_MS. Every accepted
   * command costs the states database three writes plus one more when the pulse
   * ends — a flooding device in the LAN would otherwise slow the whole host.
   *
   * @param deviceId the id-safe device path segment
   * @returns true if the command may be applied
   */
  private admitCommand(deviceId: string): boolean {
    const now = Date.now();
    let gate = this.commandGates.get(deviceId);
    if (!gate) {
      gate = new RateGate(MAX_COMMANDS_PER_SECOND, now);
      this.commandGates.set(deviceId, gate);
    }
    if (gate.allow(now)) {
      return true;
    }
    if (now - (this.rateWarnedAt.get(deviceId) ?? 0) >= RATE_WARN_INTERVAL_MS) {
      this.rateWarnedAt.set(deviceId, now);
      this.log.warn(
        `Emulated Roku "${deviceId}" receives more than ${MAX_COMMANDS_PER_SECOND} commands per second — dropping the excess (a misbehaving controller?)`,
      );
    }
    return false;
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
   * One emulated Roku's ECP server died at runtime (a server error after a good
   * start). That device answers nothing any more, so the instance is no longer
   * "every configured Roku is listening" — revise the status instead of leaving a
   * green instance behind a device that is gone, and stop announcing it, or discovery
   * would keep pointing remotes at a port nobody serves. The other devices keep
   * running, and the message names the one that failed.
   *
   * No retry here, deliberately: a port that was busy at boot is a restart race and
   * heals; a server that died while running died for a reason this code does not know,
   * and retrying it on a timer would be a log-flood generator.
   *
   * @param device the device whose server died
   */
  private onEcpFatal(device: PendingDevice): void {
    this.log.error(
      `Emulated Roku "${device.friendlyName}" stopped answering after a server error — restart the instance to bring it back.`,
    );
    this.ecpServers.delete(device.deviceId);
    const at = this.running.indexOf(device.advert);
    if (at >= 0) {
      this.running.splice(at, 1);
    }
    this.ssdp?.removeDevice(device.advert.uuid);
    this.setState("info.connection", { val: false, ack: true }).catch((e: unknown) => {
      this.log.debug(`Connection state write failed: ${errText(e)}`);
    });
  }

  /**
   * The SSDP responder died at runtime (a socket error after a good start). Stop
   * announcing into the dead socket and drop the discovery aid. The ECP servers
   * keep working, so info.connection — which reflects ECP readiness — stays true.
   */
  private onSsdpFatal(): void {
    if (this.notifyTimer) {
      this.clearInterval(this.notifyTimer);
      this.notifyTimer = undefined;
    }
    this.ssdp = undefined;
    this.log.warn(
      "SSDP discovery stopped after a socket error — already-paired remotes still work; restart the instance to re-enable discovery.",
    );
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
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  /**
   * Teardown: drop the timers and sockets synchronously, then report done only
   * once the farewell and the last write have landed.
   *
   * `info.connection` is the only status this adapter carries, and nothing else
   * resets it: the host means to, but writes its reset to the namespace root
   * instead of the datapoint (js-controller#3472). So if the final write is
   * lost, the instance shows "connected" while the adapter is off.
   *
   * A fire-and-forget write plus an immediate callback is a race, not a
   * guaranteed loss — measured on 1.1.0, it still arrived, because without
   * `common.supportedMessages.stopInstance` the process ends in an orderly way
   * and flushes what is pending. Waiting closes the race for the slow or busy
   * case, and it is safe for the same reason: no `stopInstance` means the host
   * grants the full `common.stopTimeout` instead of killing the process.
   *
   * The farewell (`ssdp:byebye`) rides in the same wait: without it a controller keeps the
   * emulated Roku in its list for up to the announced hour and sends key presses into a
   * port nobody serves.
   *
   * @param callback function to invoke once teardown is complete
   */
  private onUnload(callback: () => void): void {
    try {
      if (this.notifyTimer) {
        this.clearInterval(this.notifyTimer);
        this.notifyTimer = undefined;
      }
      if (this.retryTimer) {
        this.clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
      }
      for (const t of this.pulseTimers) {
        this.clearTimeout(t);
      }
      this.pulseTimers.clear();
      for (const t of this.holdTimers.values()) {
        this.clearTimeout(t);
      }
      this.holdTimers.clear();
      // The ECP servers close right here, synchronously: nothing about the farewell needs
      // them, and a keep-alive connection left open drags teardown toward a SIGKILL.
      for (const s of this.ecpServers.values()) {
        s.stop();
      }
      this.ecpServers.clear();
      this.deviceKeys.clear();
      this.commandGates.clear();
      this.rateWarnedAt.clear();
      this.running.length = 0;
      this.pending = [];
      // The SSDP socket is the one thing that cannot close yet — the farewell goes out
      // through it. It is closed in the callback below, whichever way that arrives.
      const farewell = this.ssdp ? this.ssdp.byebye() : Promise.resolve();
      const connection = this.setState("info.connection", { val: false, ack: true })
        // A rejected write must not become an unhandled rejection — that is a
        // crash (exit code 6) instead of an orderly stop. The trace stays at
        // debug: it explains a stale "connected" afterwards, and nobody can act
        // on it while the adapter is already going down.
        .catch((e: unknown) => {
          this.log.debug(`Final connection write failed: ${errText(e)}`);
        });
      void Promise.all([farewell, connection]).finally(() => {
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
