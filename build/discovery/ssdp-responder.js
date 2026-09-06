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
var import_errors = require("../lib/errors");
var import_lan_guard = require("../lib/lan-guard");
var import_ssdp_messages = require("./ssdp-messages");
const SSDP_PORT = 1900;
const MULTICAST_ADDR = "239.255.255.250";
class RokuSsdpResponder {
  /**
   * @param config responder configuration
   */
  constructor(config) {
    this.config = config;
    this.devices = [...config.devices];
  }
  config;
  socket;
  fatalReported = false;
  /**
   * The devices this responder answers for — its OWN list, not the caller's array.
   *
   * The set changes while the responder runs: a device whose port was busy at start-up
   * joins when its retry succeeds, and one whose server died leaves. Copying the list here
   * (instead of announcing whatever array the caller happens to still hold) keeps that
   * explicit — {@link addDevice} and {@link removeDevice} are the only ways in and out.
   */
  devices;
  /**
   * Announce one more device from now on — an emulated Roku that started late (its ECP port
   * was taken at boot and the retry got it).
   *
   * @param device the advert to answer for
   */
  addDevice(device) {
    if (!this.devices.some((d) => d.uuid === device.uuid)) {
      this.devices.push(device);
    }
  }
  /**
   * Stop answering for a device — its ECP server died, so discovery must stop pointing
   * remotes at a port nobody serves any more.
   *
   * @param uuid the identity of the device to drop
   */
  removeDevice(uuid) {
    const at = this.devices.findIndex((d) => d.uuid === uuid);
    if (at >= 0) {
      this.devices.splice(at, 1);
    }
  }
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
              `SSDP: could not pin multicast egress to ${this.config.bindIp}: ${(0, import_errors.errText)(e)} \u2014 NOTIFY may use the default interface`
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
        `SSDP multicast join failed on ${iface != null ? iface : "default interface"}: ${(0, import_errors.errText)(e)} \u2014 discovery may be incomplete`
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
    const target = (0, import_ssdp_messages.rokuSearchTarget)(text);
    if (!target) {
      return;
    }
    if (!(0, import_lan_guard.isLanClient)(address)) {
      this.config.logger.debug(`SSDP search from non-LAN ${address} ignored`);
      return;
    }
    for (const device of this.devices) {
      const response = Buffer.from((0, import_ssdp_messages.buildSearchResponse)(device, this.config.advertiseIp, target));
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
    for (const device of this.devices) {
      const notify = Buffer.from((0, import_ssdp_messages.buildAliveNotify)(device, this.config.advertiseIp));
      this.socket.send(notify, SSDP_PORT, MULTICAST_ADDR, (err) => {
        if (err) {
          this.config.logger.debug(`SSDP NOTIFY send failed: ${err.message}`);
        }
      });
    }
  }
  /**
   * Say goodbye for every device and resolve once the datagrams are out (or the deadline
   * passed). Without this a controller keeps the emulated Roku for the announced max-age —
   * an hour of a device that answers nothing, and of key presses going nowhere.
   *
   * Resolves once every datagram is out, and it always resolves: a `dgram` send reports
   * back through its callback either way, an error included, so there is no case that needs
   * a deadline of its own — and a deadline here could only be a plain `setTimeout`, which
   * this adapter does not use (the managed one refuses during shutdown). The host's
   * `stopTimeout` is the bound for teardown as a whole.
   *
   * The socket stays open until {@link stop} — sending into a closed one would throw.
   *
   * @returns a promise that always resolves
   */
  byebye() {
    const socket = this.socket;
    if (!socket || this.devices.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let open = this.devices.length;
      const done = () => {
        if (--open === 0) {
          resolve();
        }
      };
      for (const device of this.devices) {
        try {
          socket.send(Buffer.from((0, import_ssdp_messages.buildByebyeNotify)(device)), SSDP_PORT, MULTICAST_ADDR, (err) => {
            if (err) {
              this.config.logger.debug(`SSDP byebye send failed: ${err.message}`);
            }
            done();
          });
        } catch (e) {
          this.config.logger.debug(`SSDP byebye send failed: ${(0, import_errors.errText)(e)}`);
          done();
        }
      }
    });
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  RokuSsdpResponder
});
//# sourceMappingURL=ssdp-responder.js.map
