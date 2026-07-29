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
var import_ssdp_responder = require("./discovery/ssdp-responder");
var import_device_info = require("./ecp/device-info");
var import_ecp_http_server = require("./ecp/ecp-http-server");
var import_state_model = require("./ecp/state-model");
var import_device_identity = require("./lib/device-identity");
var import_pure_helpers = require("./lib/pure-helpers");
const SSDP_START_TIMEOUT_MS = 5e3;
const SSDP_NOTIFY_INTERVAL_MS = 3e5;
const KEY_PULSE_MS = 50;
const DEFAULT_ECP_PORT = 8060;
class Fakeroku extends utils.Adapter {
  ssdp;
  notifyTimer;
  ecpServers = [];
  pulseTimers = /* @__PURE__ */ new Set();
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
  }
  /** Create each device's object tree, start its ECP server, then the shared SSDP responder. */
  async onReady() {
    var _a;
    try {
      await this.setState("info.connection", { val: false, ack: true });
      const interfaceIp = this.config.networkInterface;
      if (!interfaceIp) {
        this.log.warn("No network interface selected \u2014 discovery/ECP disabled. Choose one in the settings.");
        return;
      }
      const configured = ((_a = this.config.devices) != null ? _a : []).filter((d) => d && typeof d.name === "string" && d.name.length > 0);
      if (configured.length === 0) {
        this.log.warn("No emulated Roku devices configured.");
        return;
      }
      const adverts = [];
      for (const d of configured) {
        const deviceId = (0, import_pure_helpers.sanitizeId)(d.name);
        const advert = { uuid: (0, import_device_identity.deriveUuid)(d.name), port: Number(d.port) || DEFAULT_ECP_PORT };
        await this.createDeviceStates(deviceId, d.name);
        const server = new import_ecp_http_server.EcpHttpServer({
          device: advert,
          friendlyName: d.name,
          apps: import_device_info.DEFAULT_APPS,
          interfaceIp,
          logger: this.log,
          onCommand: (cmd) => this.applyCommand(deviceId, cmd)
        });
        await server.start();
        this.ecpServers.push(server);
        adverts.push(advert);
      }
      this.ssdp = new import_ssdp_responder.RokuSsdpResponder({ devices: adverts, interfaceIp, logger: this.log });
      await this.startWithTimeout(this.ssdp.start(), SSDP_START_TIMEOUT_MS);
      this.ssdp.announce();
      this.notifyTimer = this.setInterval(() => {
        var _a2;
        return (_a2 = this.ssdp) == null ? void 0 : _a2.announce();
      }, SSDP_NOTIFY_INTERVAL_MS);
      await this.setState("info.connection", { val: true, ack: true });
      this.log.info(`Emulating ${adverts.length} Roku device(s) on ${interfaceIp}`);
    } catch (e) {
      this.log.error(`onReady failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  /**
   * Create the fixed object tree for one emulated Roku: the device, `command` +
   * `commandType`, and every standard remote key as a `button.press` state — all
   * up front, so the tree is usable before any key is ever pressed.
   *
   * @param deviceId the id-safe device path segment
   * @param friendlyName the configured device name
   */
  async createDeviceStates(deviceId, friendlyName) {
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
    for (const key of import_state_model.STANDARD_KEYS) {
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
    if (write.pulseKey) {
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
    } else if (write.holdKey) {
      void this.setState(`${deviceId}.keys.${write.holdKey.key}`, { val: write.holdKey.value, ack: true });
    }
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
   * Synchronous teardown — no await, call the callback immediately (SIGKILL otherwise).
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
      (_a = this.ssdp) == null ? void 0 : _a.stop();
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
  module.exports = (options) => new Fakeroku(options);
} else {
  (() => new Fakeroku())();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Fakeroku
});
//# sourceMappingURL=main.js.map
