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
var ecp_http_server_exports = {};
__export(ecp_http_server_exports, {
  EcpHttpServer: () => EcpHttpServer
});
module.exports = __toCommonJS(ecp_http_server_exports);
var http = __toESM(require("node:http"));
var import_ecp_command = require("./ecp-command");
var import_device_info = require("./device-info");
var import_lan_guard = require("./lan-guard");
class EcpHttpServer {
  /**
   * @param config server configuration
   */
  constructor(config) {
    this.config = config;
  }
  server;
  /** Bind the HTTP server to the interface + port. Rejects on bind error. */
  async start() {
    var _a;
    const server = http.createServer((req, res) => this.handle(req, res));
    this.server = server;
    await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      server.once("error", onError);
      server.listen(this.config.device.port, this.config.bindIp, () => {
        server.removeListener("error", onError);
        server.on("error", (err) => this.config.logger.error(`ECP server error: ${err.message}`));
        resolve();
      });
    });
    this.config.logger.debug(
      `ECP server "${this.config.friendlyName}" on ${(_a = this.config.bindIp) != null ? _a : "0.0.0.0"}:${this.config.device.port}`
    );
  }
  handle(req, res) {
    var _a, _b;
    if (!(0, import_lan_guard.isLanClient)(req.socket.remoteAddress)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    const method = (_a = req.method) != null ? _a : "GET";
    const url = (_b = req.url) != null ? _b : "/";
    if (method === "GET") {
      const body = this.routeGet(url);
      if (body === null) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/xml; charset=utf-8");
      res.end(body);
      return;
    }
    if (method === "POST") {
      req.resume();
      const cmd = (0, import_ecp_command.parseEcpCommand)("POST", url);
      if (!cmd) {
        res.statusCode = 404;
        res.end();
        return;
      }
      try {
        this.config.onCommand(cmd);
      } catch (e) {
        this.config.logger.warn(`onCommand failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      res.statusCode = 200;
      res.end();
      return;
    }
    res.statusCode = 405;
    res.end();
  }
  routeGet(url) {
    switch (url.split("?")[0]) {
      case "/":
        return (0, import_device_info.buildDescXml)(this.config.device, this.config.friendlyName, this.config.deviceType);
      case "/query/device-info":
        return (0, import_device_info.buildDeviceInfoXml)(this.config.device, this.config.friendlyName, this.config.deviceType);
      case "/query/apps":
        return (0, import_device_info.buildAppsXml)(this.config.apps);
      default:
        return null;
    }
  }
  /** Synchronous close — safe from onUnload. */
  stop() {
    if (this.server) {
      try {
        this.server.close();
      } catch {
      }
      this.server = void 0;
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  EcpHttpServer
});
//# sourceMappingURL=ecp-http-server.js.map
