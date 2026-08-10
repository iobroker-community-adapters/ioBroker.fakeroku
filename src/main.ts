import * as utils from "@iobroker/adapter-core";
import { I18n } from "@iobroker/adapter-core";
import { join } from "node:path";
import { FakerokuDeviceManagement } from "./device-management";
import type { RokuAdvert } from "./discovery/ssdp-messages";
import { RokuSsdpResponder } from "./discovery/ssdp-responder";
import { DEFAULT_APPS } from "./ecp/device-info";
import type { CommandEvent } from "./ecp/ecp-command";
import { EcpHttpServer } from "./ecp/ecp-http-server";
import { commandToStateWrite, type DeviceType, keysForType } from "./ecp/state-model";
import { DEFAULT_ECP_PORT } from "./lib/constants";
import { deriveUuid } from "./lib/device-identity";
import { detectLocalIPv4s, detectPrimaryIPv4 } from "./lib/detect-ip";
import { planObjectCleanup } from "./lib/object-cleanup";
import { sanitizeId } from "./lib/pure-helpers";

/** Managed timeout for a stuck SSDP start (a busy port 1900 must not hang onReady). */
const SSDP_START_TIMEOUT_MS = 5000;
/** Proactive ssdp:alive interval so controllers find the device without searching. */
const SSDP_NOTIFY_INTERVAL_MS = 300_000;
/** How long a keypress pulses its keys.<Key> state true before falling back to false. */
const KEY_PULSE_MS = 50;
/** Safety cap for a held key: a keydown with no matching keyup resets after this. */
const HOLD_MAX_MS = 30_000;

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
  private readonly ecpServers: EcpHttpServer[] = [];
  private readonly pulseTimers = new Set<ioBroker.Timeout>();
  /** Per held key id, its watchdog timer — so a keydown without a keyup cannot pin it true forever. */
  private readonly holdTimers = new Map<string, ioBroker.Timeout>();
  /** Per device, the key names it exposes — so a keypress only writes keys this device carries. */
  private readonly deviceKeys = new Map<string, ReadonlySet<string>>();
  /** Device-manager backend: the emulated Rokus as cards with add/edit/delete. */
  private readonly deviceManagement: FakerokuDeviceManagement;

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

      // Empty AND "0.0.0.0" both mean "auto": bind all interfaces, advertise the
      // detected primary IP so the adapter runs without configuration. js-controller
      // never rewrites an existing native default, so instances from before 0.5.1
      // still carry "" — both must take the auto path. A concrete IP is honoured as-is.
      // Migration: a pre-0.5.0 instance has no `networkInterface`, only the old `BIND` —
      // adopt it so a multi-homed host keeps the interface the user had configured.
      const configuredIp = this.config.networkInterface || this.config.BIND;
      const bindIp = configuredIp && configuredIp !== "0.0.0.0" ? configuredIp : undefined;
      const advertiseIp = bindIp ?? detectPrimaryIPv4();
      if (!advertiseIp) {
        this.log.warn("No routable IPv4 address found to advertise — set the network interface in the settings.");
        return;
      }

      const configured = (this.config.devices ?? []).filter(d => d && typeof d.name === "string" && d.name.length > 0);
      if (configured.length === 0) {
        this.log.warn("No emulated Roku devices configured.");
        return;
      }

      const adverts: RokuAdvert[] = [];
      const seenIds = new Set<string>();
      for (const d of configured) {
        const deviceId = sanitizeId(d.name);
        // Two configured names can sanitize to the same object id — the admin guards
        // against it, but a hand-edited config could still carry it. Skip the duplicate
        // instead of letting two devices fight over one object tree.
        if (seenIds.has(deviceId)) {
          this.log.warn(`Emulated Roku "${d.name}" maps to an object id already in use (${deviceId}) — skipping it.`);
          continue;
        }
        const deviceType: DeviceType = d.type === "tv" ? "tv" : "player";
        const keys = keysForType(deviceType);
        // Adopt the device's persisted uuid (old adapter or an earlier run) so the SSDP
        // identity — and thus the controller pairing — survives an update; derive a stable
        // one from the name only for a device that never had one.
        const advert: RokuAdvert = { uuid: d.uuid || deriveUuid(d.name), port: Number(d.port) || DEFAULT_ECP_PORT };
        try {
          await this.createDeviceStates(deviceId, d.name, keys);
          const server = new EcpHttpServer({
            device: advert,
            friendlyName: d.name,
            apps: DEFAULT_APPS,
            deviceType,
            bindIp,
            logger: this.log,
            onCommand: cmd => this.applyCommand(deviceId, cmd),
          });
          await server.start();
          this.ecpServers.push(server);
          this.deviceKeys.set(deviceId, new Set(keys));
          seenIds.add(deviceId);
          adverts.push(advert);
        } catch (e) {
          // One device's failure (a busy ECP port) must not take the others down.
          this.log.warn(
            `Emulated Roku "${d.name}" could not start on port ${advert.port}: ${e instanceof Error ? e.message : String(e)} — skipping it.`,
          );
        }
      }

      await this.cleanupOrphans(new Set(configured.map(d => sanitizeId(d.name))));

      if (adverts.length === 0) {
        // Nothing is controllable — leave info.connection false and stop here.
        this.log.error("No emulated Roku device could be started — check the configured ports for conflicts.");
        return;
      }

      // Discovery is only an aid; the ECP servers above already make the adapter
      // controllable. Isolate the SSDP start so a busy port 1900 (or a stuck bind)
      // degrades to "discovery off, already-paired remotes still work" instead of
      // failing the whole start-up. In the auto case join every routable interface so
      // a multi-homed host is discoverable on all its LANs; a chosen interface pins
      // both membership and NOTIFY egress.
      const membershipInterfaces = bindIp ? [bindIp] : detectLocalIPv4s();
      this.ssdp = new RokuSsdpResponder({
        devices: adverts,
        bindIp,
        advertiseIp,
        membershipInterfaces,
        logger: this.log,
        onFatalError: () => this.onSsdpFatal(),
      });
      try {
        await this.startWithTimeout(this.ssdp.start(), SSDP_START_TIMEOUT_MS);
        this.ssdp.announce();
        this.notifyTimer = this.setInterval(() => this.ssdp?.announce(), SSDP_NOTIFY_INTERVAL_MS);
      } catch (e) {
        this.log.warn(
          `SSDP discovery unavailable: ${e instanceof Error ? e.message : String(e)} — already-paired remotes still work; set the network interface if devices are not found.`,
        );
        this.ssdp = undefined;
      }

      await this.setState("info.connection", { val: true, ack: true });
      this.log.info(
        `Emulating ${adverts.length} Roku device(s), advertising on ${advertiseIp}${this.ssdp ? "" : " (discovery off)"}`,
      );
    } catch (e) {
      this.log.error(`onReady failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Create the fixed object tree for one emulated Roku: the device, `command` +
   * `commandType`, and one `sensor` boolean state per key the device type exposes —
   * all up front, so the tree is usable before any key is ever pressed.
   *
   * @param deviceId the id-safe device path segment
   * @param friendlyName the configured device name
   * @param keys the key names to create for this device (from its type)
   */
  private async createDeviceStates(deviceId: string, friendlyName: string, keys: readonly string[]): Promise<void> {
    await this.extendObject(deviceId, { type: "device", common: { name: friendlyName }, native: {} });
    await this.extendObject(`${deviceId}.command`, {
      type: "state",
      common: { name: "Last command", type: "string", role: "text", read: true, write: false, def: "" },
      native: {},
    });
    await this.extendObject(`${deviceId}.commandType`, {
      type: "state",
      common: { name: "Last command type", type: "string", role: "text", read: true, write: false, def: "" },
      native: {},
    });
    await this.extendObject(`${deviceId}.keys`, { type: "channel", common: { name: "keys" }, native: {} });
    for (const key of keys) {
      await this.extendObject(`${deviceId}.keys.${key}`, {
        type: "state",
        // "sensor" = generic boolean read-only (active/inactive). The docs suggest
        // button.press for a keypress-as-state, but the repochecker rejects it
        // (E1010 — not in its role list); sensor is the gate-conformant fit.
        common: { name: key, type: "boolean", role: "sensor", read: true, write: false, def: false },
        native: {},
      });
    }
  }

  /**
   * Remove objects left over from an earlier version or config — the legacy
   * `apps` node, keys no longer standard, and whole device sub-trees no longer
   * configured (a renamed/removed device). The adapter otherwise only ever
   * creates objects, so without this the tree would accrete stale entries.
   *
   * @param configuredDeviceIds the id-safe names of the currently configured devices
   */
  private async cleanupOrphans(configuredDeviceIds: ReadonlySet<string>): Promise<void> {
    const objects = await this.getAdapterObjectsAsync();
    const prefix = `${this.namespace}.`;
    const existingIds = Object.keys(objects)
      .filter(id => id.startsWith(prefix))
      .map(id => id.slice(prefix.length));
    const toDelete = planObjectCleanup(existingIds, configuredDeviceIds, this.deviceKeys);
    for (const id of toDelete) {
      await this.delObjectAsync(id, { recursive: true }).catch((e: unknown) => {
        this.log.debug(`cleanup: could not delete ${id}: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    if (toDelete.length > 0) {
      this.log.info(`Removed ${toDelete.length} orphaned object(s) from an earlier version or config.`);
    }
  }

  /**
   * Apply a received ECP command to this device's states: record it in `command`
   * / `commandType`, and pulse or hold the standard key if it is one.
   *
   * @param deviceId the id-safe device path segment
   * @param cmd the parsed ECP command
   */
  private applyCommand(deviceId: string, cmd: CommandEvent): void {
    const write = commandToStateWrite(cmd);
    void this.setState(`${deviceId}.command`, { val: write.command, ack: true });
    void this.setState(`${deviceId}.commandType`, { val: write.commandType, ack: true });
    // Only write keys.<Key> if THIS device's type carries the key — a player has no
    // TV key objects, so a stray TV keypress lands in `command` only, never a missing state.
    const keys = this.deviceKeys.get(deviceId);
    if (write.pulseKey && keys?.has(write.pulseKey)) {
      const id = `${deviceId}.keys.${write.pulseKey}`;
      void this.setState(id, { val: true, ack: true });
      const timer = this.setTimeout(() => {
        if (timer) {
          this.pulseTimers.delete(timer);
        }
        void this.setState(id, { val: false, ack: true });
      }, KEY_PULSE_MS);
      if (timer) {
        this.pulseTimers.add(timer);
      }
    } else if (write.holdKey && keys?.has(write.holdKey.key)) {
      const id = `${deviceId}.keys.${write.holdKey.key}`;
      void this.setState(id, { val: write.holdKey.value, ack: true });
      // A keydown holds the key true until its keyup. Arm a watchdog so a lost keyup
      // (controller disconnects mid-press) cannot pin the key true forever; a keyup
      // clears it, and a repeated keydown re-arms it.
      const pending = this.holdTimers.get(id);
      if (pending) {
        this.clearTimeout(pending);
        this.holdTimers.delete(id);
      }
      if (write.holdKey.value) {
        const timer = this.setTimeout(() => {
          this.holdTimers.delete(id);
          void this.setState(id, { val: false, ack: true });
        }, HOLD_MAX_MS);
        if (timer) {
          this.holdTimers.set(id, timer);
        }
      }
    }
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
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  /**
   * Synchronous teardown — no await, call the callback immediately (SIGKILL otherwise).
   *
   * @param callback function to invoke once teardown is complete
   */
  private onUnload(callback: () => void): void {
    try {
      if (this.notifyTimer) {
        this.clearInterval(this.notifyTimer);
        this.notifyTimer = undefined;
      }
      for (const t of this.pulseTimers) {
        this.clearTimeout(t);
      }
      this.pulseTimers.clear();
      for (const t of this.holdTimers.values()) {
        this.clearTimeout(t);
      }
      this.holdTimers.clear();
      this.ssdp?.stop();
      for (const s of this.ecpServers) {
        s.stop();
      }
      void this.setState("info.connection", { val: false, ack: true });
      callback();
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
