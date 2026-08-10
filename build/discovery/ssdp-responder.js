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
var ssdp_responder_exports = {};
__export(ssdp_responder_exports, {
  RokuSsdpResponder: () => RokuSsdpResponder
});
module.exports = __toCommonJS(ssdp_responder_exports);
var dgram = __toESM(require("node:dgram"));
var import_ssdp_messages = require("./ssdp-messages");
const SSDP_PORT = 1900;
const MULTICAST_ADDR = "239.255.255.250";
class RokuSsdpResponder {
  /**
   * @param config responder configuration
   */
  constructor(config) {
    this.config = config;
  }
  socket;
  fatalReported = false;
  /** Bind on 1900, join multicast on the selected interface(s), start answering. Rejects on bind error. */
  async start() {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket = socket;
    await new Promise((resolve, reject) => {
      const onBindError = (err) => reject(err);
      socket.once("error", onBindError);
      socket.bind(SSDP_PORT, () => {
        socket.removeListener("error", onBindError);
        this.joinMulticast(socket);
        if (this.config.bindIp) {
          try {
            socket.setMulticastInterface(this.config.bindIp);
          } catch (e) {
            this.config.logger.warn(
              `SSDP: could not pin multicast egress to ${this.config.bindIp}: ${errMsg(e)} \u2014 NOTIFY may use the default interface`
            );
          }
        }
        socket.on("error", (err) => this.onSocketError(err));
        socket.on("message", (msg, rinfo) => this.onMessage(msg.toString("utf8"), rinfo.address, rinfo.port));
        resolve();
      });
    });
    const join = this.config.membershipInterfaces.length ? this.config.membershipInterfaces.join(", ") : "default";
    this.config.logger.debug(
      `Roku SSDP responder on :${SSDP_PORT}, advertising ${this.config.advertiseIp} (join: ${join})`
    );
  }
  /**
   * Join the multicast group on each selected interface, or on the OS default when
   * none is known.
   *
   * @param socket the bound SSDP socket
   */
  joinMulticast(socket) {
    const ifaces = this.config.membershipInterfaces;
    if (ifaces.length === 0) {
      this.tryJoin(socket, void 0);
      return;
    }
    for (const ip of ifaces) {
      this.tryJoin(socket, ip);
    }
  }
  /**
   * Join the group on one interface; a failure warns but does not throw, so one bad
   * interface cannot stop the responder.
   *
   * @param socket the bound SSDP socket
   * @param iface the interface IP to join on, or undefined for the OS default
   */
  tryJoin(socket, iface) {
    try {
      socket.addMembership(MULTICAST_ADDR, iface);
    } catch (e) {
      this.config.logger.warn(
        `SSDP multicast join failed on ${iface != null ? iface : "default interface"}: ${errMsg(e)} \u2014 discovery may be incomplete`
      );
    }
  }
  /**
   * A socket error after a good start — discovery is dead. Close the socket and tell
   * the adapter once so it can stop announcing and revise its connection state.
   *
   * @param err the socket error
   */
  onSocketError(err) {
    this.config.logger.error(`SSDP socket error: ${err.message}`);
    const notify = this.config.onFatalError;
    this.stop();
    if (notify && !this.fatalReported) {
      this.fatalReported = true;
      notify(err);
    }
  }
  onMessage(text, address, port) {
    var _a;
    if (!(0, import_ssdp_messages.matchesRokuSearch)(text)) {
      return;
    }
    for (const device of this.config.devices) {
      const response = Buffer.from((0, import_ssdp_messages.buildSearchResponse)(device, this.config.advertiseIp));
      (_a = this.socket) == null ? void 0 : _a.send(response, port, address, (err) => {
        if (err) {
          this.config.logger.warn(`SSDP response send failed: ${err.message}`);
        }
      });
    }
  }
  /** Send one proactive ssdp:alive burst for every device. The adapter calls this on a managed interval. */
  announce() {
    if (!this.socket) {
      return;
    }
    for (const device of this.config.devices) {
      const notify = Buffer.from((0, import_ssdp_messages.buildAliveNotify)(device, this.config.advertiseIp));
      this.socket.send(notify, SSDP_PORT, MULTICAST_ADDR, (err) => {
        if (err) {
          this.config.logger.debug(`SSDP NOTIFY send failed: ${err.message}`);
        }
      });
    }
  }
  /** Synchronous close — safe to call from onUnload. Closing the socket drops its memberships. */
  stop() {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
      }
      this.socket = void 0;
    }
  }
}
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  RokuSsdpResponder
});
//# sourceMappingURL=ssdp-responder.js.map
