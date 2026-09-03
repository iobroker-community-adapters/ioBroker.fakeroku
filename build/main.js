"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var main_exports = {};
__export(main_exports, {
  Fakeroku: () => Fakeroku
});
module.exports = __toCommonJS(main_exports);
var utils = __toESM(require("@iobroker/adapter-core"));
var import_adapter_core = require("@iobroker/adapter-core");
var import_node_path = require("node:path");
var import_device_management = require("./device-management");
var import_ssdp_responder = require("./discovery/ssdp-responder");
var import_device_info = require("./ecp/device-info");
var import_ecp_command = require("./ecp/ecp-command");
var import_ecp_http_server = require("./ecp/ecp-http-server");
var import_state_model = require("./ecp/state-model");
var import_constants = require("./lib/constants");
var import_device_identity = require("./lib/device-identity");
var import_detect_ip = require("./lib/detect-ip");
var import_errors = require("./lib/errors");
var import_i18n = require("./lib/i18n");
var import_object_cleanup = require("./lib/object-cleanup");
var import_pure_helpers = require("./lib/pure-helpers");
var import_rate_gate = require("./lib/rate-gate");
const SSDP_START_TIMEOUT_MS = 5e3;
const SSDP_NOTIFY_INTERVAL_MS = 3e5;
const KEY_PULSE_MS = 50;
const HOLD_MAX_MS = 3e4;
const MAX_COMMANDS_PER_SECOND = 25;
const RATE_WARN_INTERVAL_MS = 6e4;
class Fakeroku extends utils.Adapter {
  ssdp;
  notifyTimer;
  ecpServers = [];
  pulseTimers = /* @__PURE__ */ new Set();
  /** Per held key id, its watchdog timer — so a keydown without a keyup cannot pin it true forever. */
  holdTimers = /* @__PURE__ */ new Map();
  /** Per device, the key names it exposes — so a keypress only writes keys this device carries. */
  deviceKeys = /* @__PURE__ */ new Map();
  /** Per device, its command rate gate — the write-flood protection for the states database. */
  commandGates = /* @__PURE__ */ new Map();
  /** Per device, when the dropped-commands warning was last written. */
  rateWarnedAt = /* @__PURE__ */ new Map();
  /** Device-manager backend: the emulated Rokus as cards with add/edit/delete. */
  deviceManagement;
  // Construction seams for the two network-facing collaborators. Production uses
  // the real classes; the orchestration tests swap them for fakes so onReady's
  // wiring (per-device isolation, SSDP degradation, timers) is testable without
  // binding a port. Behaviour is unchanged — same constructors, same arguments.
  makeEcpServer = (options) => new import_ecp_http_server.EcpHttpServer(options);
  makeSsdpResponder = (options) => new import_ssdp_responder.RokuSsdpResponder(options);
  /**
   * @param options adapter options passed through by js-controller
   */
  constructor(options = {}) {
    super({
      ...options,
      name: "fakeroku"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.deviceManagement = new import_device_management.FakerokuDeviceManagement(this);
  }
  /** Create each device's object tree, start its ECP server, then the shared SSDP responder. */
  async onReady() {
    var _a;
    try {
      await this.setState("info.connection", { val: false, ack: true });
      await import_adapter_core.I18n.init((0, import_node_path.join)(this.adapterDir, "admin"), this);
      await this.refreshOwnObjects();
      const configuredIp = this.config.networkInterface || this.config.BIND;
      const bindIp = configuredIp && configuredIp !== "0.0.0.0" ? configuredIp : void 0;
      const advertiseIp = bindIp != null ? bindIp : (0, import_detect_ip.detectPrimaryIPv4)();
      if (!advertiseIp) {
        this.log.warn("No routable IPv4 address found to advertise \u2014 set the network interface in the settings.");
        return;
      }
      const configured = ((_a = this.config.devices) != null ? _a : []).filter((d) => d && typeof d.name === "string" && d.name.length > 0);
      if (configured.length === 0) {
        this.log.warn("No emulated Roku devices configured.");
        return;
      }
      const adverts = [];
      const seenIds = /* @__PURE__ */ new Set();
      for (const d of configured) {
        const deviceId = (0, import_pure_helpers.sanitizeId)(d.name);
        if (seenIds.has(deviceId)) {
          this.log.warn(`Emulated Roku "${d.name}" maps to an object id already in use (${deviceId}) \u2014 skipping it.`);
          continue;
        }
        if (import_constants.RESERVED_IDS.has(deviceId)) {
          this.log.warn(
            `Emulated Roku "${d.name}" maps to the object id "${deviceId}", which the adapter reserves for its own status \u2014 skipping it.`
          );
          continue;
        }
        const deviceType = d.type === "tv" ? "tv" : "player";
        const keys = (0, import_state_model.keysForType)(deviceType);
        const uuid = (0, import_device_identity.resolveDeviceUuid)(d);
        if (d.uuid && uuid !== d.uuid) {
          this.log.warn(`Emulated Roku "${d.name}" has an unusable device id in its config \u2014 using a derived one.`);
        }
        const advert = { uuid, port: Number(d.port) || import_constants.DEFAULT_ECP_PORT };
        let server;
        try {
          await this.createDeviceStates(deviceId, d.name, keys);
          server = this.makeEcpServer({
            device: advert,
            friendlyName: d.name,
            apps: import_device_info.DEFAULT_APPS,
            deviceType,
            bindIp,
            logger: this.log,
            onCommand: (cmd) => this.applyCommand(deviceId, cmd)
          });
          await server.start();
          this.ecpServers.push(server);
          this.deviceKeys.set(deviceId, new Set(keys));
          seenIds.add(deviceId);
          adverts.push(advert);
        } catch (e) {
          server == null ? void 0 : server.stop();
          this.log.warn(
            `Emulated Roku "${d.name}" could not start on port ${advert.port}: ${(0, import_errors.errText)(e)} \u2014 skipping it.`
          );
        }
      }
      await this.cleanupOrphans(new Set(configured.map((d) => (0, import_pure_helpers.sanitizeId)(d.name))));
      if (adverts.length === 0) {
        this.log.error("No emulated Roku device could be started \u2014 check the configured ports for conflicts.");
        return;
      }
      const membershipInterfaces = bindIp ? [bindIp] : (0, import_detect_ip.detectLocalIPv4s)();
      const ssdp = this.makeSsdpResponder({
        devices: adverts,
        bindIp,
        advertiseIp,
        membershipInterfaces,
        logger: this.log,
        onFatalError: () => this.onSsdpFatal()
      });
      this.ssdp = ssdp;
      try {
        await this.startWithTimeout(ssdp.start(), SSDP_START_TIMEOUT_MS);
        ssdp.announce();
        this.notifyTimer = this.setInterval(() => {
          var _a2;
          return (_a2 = this.ssdp) == null ? void 0 : _a2.announce();
        }, SSDP_NOTIFY_INTERVAL_MS);
      } catch (e) {
        this.log.warn(
          `SSDP discovery unavailable: ${(0, import_errors.errText)(e)} \u2014 already-paired remotes still work; set the network interface if devices are not found.`
        );
        ssdp.stop();
        this.ssdp = void 0;
      }
      const allStarted = adverts.length === configured.length;
      await this.setState("info.connection", { val: allStarted, ack: true });
      const where = `advertising on ${advertiseIp}${this.ssdp ? "" : " (discovery off)"}`;
      if (allStarted) {
        this.log.info(`Emulating ${adverts.length} Roku device(s), ${where}`);
      } else {
        this.log.error(
          `Only ${adverts.length} of ${configured.length} configured Roku device(s) could be started, ${where} \u2014 fix the cause reported above; the instance stays disconnected until every device runs.`
        );
      }
    } catch (e) {
      this.log.error(`onReady failed: ${(0, import_errors.errText)(e)}`);
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
   * "info" turned it into a device object (see the reserved-id guard in onReady).
   */
  async refreshOwnObjects() {
    await this.extendObject("info", {
      type: "channel",
      common: { name: (0, import_i18n.tName)("channelInfo") },
      native: {}
    });
    await this.extendObject("info.connection", {
      type: "state",
      common: {
        name: (0, import_i18n.tName)("connectionStatus"),
        desc: (0, import_i18n.tDesc)("connectionStatusDesc"),
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false
      },
      native: {}
    });
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
   * @param deviceId the id-safe device path segment
   * @param friendlyName the configured device name
   * @param keys the key names to create for this device (from its type)
   */
  async createDeviceStates(deviceId, friendlyName, keys) {
    await this.extendObject(deviceId, { type: "device", common: { name: (0, import_i18n.tRaw)(friendlyName) }, native: {} });
    await this.extendObject(`${deviceId}.command`, {
      type: "state",
      common: {
        name: (0, import_i18n.tName)("stateLastCommand"),
        desc: (0, import_i18n.tDesc)("stateLastCommandDesc"),
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: ""
      },
      native: {}
    });
    await this.extendObject(`${deviceId}.commandType`, {
      type: "state",
      common: {
        name: (0, import_i18n.tName)("stateLastCommandType"),
        desc: (0, import_i18n.tDesc)("stateLastCommandTypeDesc"),
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: "",
        // The fixed verb list, so the admin shows the value as a label. Plain strings
        // only — a translation object here crashes the admin's object view.
        states: Object.fromEntries(import_ecp_command.COMMAND_TYPES.map((verb) => [verb, verb]))
      },
      native: {}
    });
    await this.extendObject(`${deviceId}.keys`, {
      type: "channel",
      common: { name: (0, import_i18n.tName)("channelKeys"), desc: (0, import_i18n.tDesc)("channelKeysDesc") },
      native: {}
    });
    for (const key of keys) {
      await this.extendObject(`${deviceId}.keys.${key}`, {
        type: "state",
        // "sensor" = generic boolean read-only (active/inactive). The docs suggest
        // button.press for a keypress-as-state, but the repochecker rejects it
        // (E1010 — not in its role list); sensor is the gate-conformant fit.
        // The name is the ECP key identifier and identical in every language, but
        // it still has to BE a translation object (tRaw), never a bare string.
        // No desc: the key name already says everything there is to say.
        common: { name: (0, import_i18n.tRaw)(key), type: "boolean", role: "sensor", read: true, write: false, def: false },
        native: {}
      });
    }
    await Promise.all(keys.map((key) => this.setStateChangedAsync(`${deviceId}.keys.${key}`, { val: false, ack: true })));
  }
  /**
   * Remove objects left over from an earlier version or config — the legacy
   * `apps` node, keys no longer standard, and whole device sub-trees no longer
   * configured (a renamed/removed device). The adapter otherwise only ever
   * creates objects, so without this the tree would accrete stale entries.
   *
   * @param configuredDeviceIds the id-safe names of the currently configured devices
   */
  async cleanupOrphans(configuredDeviceIds) {
    const objects = await this.getAdapterObjectsAsync();
    const prefix = `${this.namespace}.`;
    const existingIds = Object.keys(objects).filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
    const toDelete = (0, import_object_cleanup.planObjectCleanup)(existingIds, configuredDeviceIds, this.deviceKeys);
    for (const id of toDelete) {
      await this.delObjectAsync(id, { recursive: true }).catch((e) => {
        this.log.debug(`cleanup: could not delete ${id}: ${(0, import_errors.errText)(e)}`);
      });
    }
    if (toDelete.length > 0) {
      this.log.debug(`Removed ${toDelete.length} orphaned object(s) from an earlier version or config.`);
    }
  }
  /**
   * Apply a received ECP command to this device's states: record it in `command`
   * / `commandType`, and pulse or hold the standard key if it is one.
   *
   * @param deviceId the id-safe device path segment
   * @param cmd the parsed ECP command
   */
  applyCommand(deviceId, cmd) {
    if (!this.admitCommand(deviceId)) {
      return;
    }
    const write = (0, import_state_model.commandToStateWrite)(cmd);
    this.writeState(`${deviceId}.command`, write.command);
    this.writeState(`${deviceId}.commandType`, write.commandType);
    const keys = this.deviceKeys.get(deviceId);
    if (write.pulseKey && (keys == null ? void 0 : keys.has(write.pulseKey))) {
      const id = `${deviceId}.keys.${write.pulseKey}`;
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
    } else if (write.holdKey && (keys == null ? void 0 : keys.has(write.holdKey.key))) {
      const id = `${deviceId}.keys.${write.holdKey.key}`;
      this.writeState(id, write.holdKey.value);
      const pending = this.holdTimers.get(id);
      if (pending) {
        this.clearTimeout(pending);
        this.holdTimers.delete(id);
      }
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
  admitCommand(deviceId) {
    var _a;
    const now = Date.now();
    let gate = this.commandGates.get(deviceId);
    if (!gate) {
      gate = new import_rate_gate.RateGate(MAX_COMMANDS_PER_SECOND, now);
      this.commandGates.set(deviceId, gate);
    }
    if (gate.allow(now)) {
      return true;
    }
    if (now - ((_a = this.rateWarnedAt.get(deviceId)) != null ? _a : 0) >= RATE_WARN_INTERVAL_MS) {
      this.rateWarnedAt.set(deviceId, now);
      this.log.warn(
        `Emulated Roku "${deviceId}" receives more than ${MAX_COMMANDS_PER_SECOND} commands per second \u2014 dropping the excess (a misbehaving controller?)`
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
  writeState(id, val) {
    this.setState(id, { val, ack: true }).catch((e) => {
      this.log.debug(`State write ${id} failed: ${(0, import_errors.errText)(e)}`);
    });
  }
  /**
   * The SSDP responder died at runtime (a socket error after a good start). Stop
   * announcing into the dead socket and drop the discovery aid. The ECP servers
   * keep working, so info.connection — which reflects ECP readiness — stays true.
   */
  onSsdpFatal() {
    if (this.notifyTimer) {
      this.clearInterval(this.notifyTimer);
      this.notifyTimer = void 0;
    }
    this.ssdp = void 0;
    this.log.warn(
      "SSDP discovery stopped after a socket error \u2014 already-paired remotes still work; restart the instance to re-enable discovery."
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
  startWithTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = this.setTimeout(() => reject(new Error(`SSDP start timed out after ${ms} ms`)), ms);
      const clear = () => {
        if (timer) {
          this.clearTimeout(timer);
        }
      };
      promise.then(
        () => {
          clear();
          resolve();
        },
        (e) => {
          clear();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      );
    });
  }
  /**
   * Teardown: drop the timers and sockets synchronously, then report done only
   * once the last write has landed.
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
   * @param callback function to invoke once teardown is complete
   */
  onUnload(callback) {
    var _a;
    try {
      if (this.notifyTimer) {
        this.clearInterval(this.notifyTimer);
        this.notifyTimer = void 0;
      }
      for (const t of this.pulseTimers) {
        this.clearTimeout(t);
      }
      this.pulseTimers.clear();
      for (const t of this.holdTimers.values()) {
        this.clearTimeout(t);
      }
      this.holdTimers.clear();
      (_a = this.ssdp) == null ? void 0 : _a.stop();
      for (const s of this.ecpServers) {
        s.stop();
      }
      void this.setState("info.connection", { val: false, ack: true }).catch((e) => {
        this.log.debug(`Final connection write failed: ${(0, import_errors.errText)(e)}`);
      }).finally(() => callback());
    } catch {
      callback();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Fakeroku(options);
} else {
  (() => new Fakeroku())();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Fakeroku
});
//# sourceMappingURL=main.js.map
