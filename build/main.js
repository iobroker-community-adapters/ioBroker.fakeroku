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
var import_ecp_http_server = require("./ecp/ecp-http-server");
var import_state_model = require("./ecp/state-model");
var import_constants = require("./lib/constants");
var import_device_identity = require("./lib/device-identity");
var import_detect_ip = require("./lib/detect-ip");
var import_object_cleanup = require("./lib/object-cleanup");
var import_pure_helpers = require("./lib/pure-helpers");
const SSDP_START_TIMEOUT_MS = 5e3;
const SSDP_NOTIFY_INTERVAL_MS = 3e5;
const KEY_PULSE_MS = 50;
const HOLD_MAX_MS = 3e4;
class Fakeroku extends utils.Adapter {
  ssdp;
  notifyTimer;
  ecpServers = [];
  pulseTimers = /* @__PURE__ */ new Set();
  /** Per held key id, its watchdog timer — so a keydown without a keyup cannot pin it true forever. */
  holdTimers = /* @__PURE__ */ new Map();
  /** Per device, the key names it exposes — so a keypress only writes keys this device carries. */
  deviceKeys = /* @__PURE__ */ new Map();
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
        const deviceType = d.type === "tv" ? "tv" : "player";
        const keys = (0, import_state_model.keysForType)(deviceType);
        const advert = { uuid: d.uuid || (0, import_device_identity.deriveUuid)(d.name), port: Number(d.port) || import_constants.DEFAULT_ECP_PORT };
        try {
          await this.createDeviceStates(deviceId, d.name, keys);
          const server = this.makeEcpServer({
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
          this.log.warn(
            `Emulated Roku "${d.name}" could not start on port ${advert.port}: ${e instanceof Error ? e.message : String(e)} \u2014 skipping it.`
          );
        }
      }
      await this.cleanupOrphans(new Set(configured.map((d) => (0, import_pure_helpers.sanitizeId)(d.name))));
      if (adverts.length === 0) {
        this.log.error("No emulated Roku device could be started \u2014 check the configured ports for conflicts.");
        return;
      }
      const membershipInterfaces = bindIp ? [bindIp] : (0, import_detect_ip.detectLocalIPv4s)();
      this.ssdp = this.makeSsdpResponder({
        devices: adverts,
        bindIp,
        advertiseIp,
        membershipInterfaces,
        logger: this.log,
        onFatalError: () => this.onSsdpFatal()
      });
      try {
        await this.startWithTimeout(this.ssdp.start(), SSDP_START_TIMEOUT_MS);
        this.ssdp.announce();
        this.notifyTimer = this.setInterval(() => {
          var _a2;
          return (_a2 = this.ssdp) == null ? void 0 : _a2.announce();
        }, SSDP_NOTIFY_INTERVAL_MS);
      } catch (e) {
        this.log.warn(
          `SSDP discovery unavailable: ${e instanceof Error ? e.message : String(e)} \u2014 already-paired remotes still work; set the network interface if devices are not found.`
        );
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
  async createDeviceStates(deviceId, friendlyName, keys) {
    await this.extendObject(deviceId, { type: "device", common: { name: friendlyName }, native: {} });
    await this.extendObject(`${deviceId}.command`, {
      type: "state",
      common: { name: "Last command", type: "string", role: "text", read: true, write: false, def: "" },
      native: {}
    });
    await this.extendObject(`${deviceId}.commandType`, {
      type: "state",
      common: { name: "Last command type", type: "string", role: "text", read: true, write: false, def: "" },
      native: {}
    });
    await this.extendObject(`${deviceId}.keys`, { type: "channel", common: { name: "keys" }, native: {} });
    for (const key of keys) {
      await this.extendObject(`${deviceId}.keys.${key}`, {
        type: "state",
        // "sensor" = generic boolean read-only (active/inactive). The docs suggest
        // button.press for a keypress-as-state, but the repochecker rejects it
        // (E1010 — not in its role list); sensor is the gate-conformant fit.
        common: { name: key, type: "boolean", role: "sensor", read: true, write: false, def: false },
        native: {}
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
  async cleanupOrphans(configuredDeviceIds) {
    const objects = await this.getAdapterObjectsAsync();
    const prefix = `${this.namespace}.`;
    const existingIds = Object.keys(objects).filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
    const toDelete = (0, import_object_cleanup.planObjectCleanup)(existingIds, configuredDeviceIds, this.deviceKeys);
    for (const id of toDelete) {
      await this.delObjectAsync(id, { recursive: true }).catch((e) => {
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
  applyCommand(deviceId, cmd) {
    const write = (0, import_state_model.commandToStateWrite)(cmd);
    void this.setState(`${deviceId}.command`, { val: write.command, ack: true });
    void this.setState(`${deviceId}.commandType`, { val: write.commandType, ack: true });
    const keys = this.deviceKeys.get(deviceId);
    if (write.pulseKey && (keys == null ? void 0 : keys.has(write.pulseKey))) {
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
    } else if (write.holdKey && (keys == null ? void 0 : keys.has(write.holdKey.key))) {
      const id = `${deviceId}.keys.${write.holdKey.key}`;
      void this.setState(id, { val: write.holdKey.value, ack: true });
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
        this.log.debug(`Final connection write failed: ${e instanceof Error ? e.message : String(e)}`);
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
