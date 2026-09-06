"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var ssdp_messages_exports = {};
__export(ssdp_messages_exports, {
  buildAliveNotify: () => buildAliveNotify,
  buildByebyeNotify: () => buildByebyeNotify,
  buildSearchResponse: () => buildSearchResponse,
  rokuSearchTarget: () => rokuSearchTarget
});
module.exports = __toCommonJS(ssdp_messages_exports);
const SERVER_SIG = "Roku UPnP/1.0 MiniUPnPd/1.4";
const MAX_AGE = 3600;
const ANSWERED_TARGETS = ["roku:ecp", "ssdp:all", "upnp:rootdevice"];
function rokuSearchTarget(message) {
  var _a, _b;
  if (!/^M-SEARCH \* HTTP\/1\.1/im.test(message)) {
    return null;
  }
  if (!/^MAN:\s*"ssdp:discover"/im.test(message)) {
    return null;
  }
  const st = (_a = message.match(/^ST:\s*(.+?)\s*$/im)) == null ? void 0 : _a[1];
  return (_b = ANSWERED_TARGETS.find((target) => target === st)) != null ? _b : null;
}
function buildSearchResponse(device, advertiseIp, target = "roku:ecp") {
  return [
    "HTTP/1.1 200 OK",
    `Cache-Control: max-age=${MAX_AGE}`,
    `ST: ${target === "upnp:rootdevice" ? "upnp:rootdevice" : "roku:ecp"}`,
    `USN: uuid:roku:ecp:${device.uuid}`,
    "Ext: ",
    `Server: ${SERVER_SIG}`,
    `LOCATION: http://${advertiseIp}:${device.port}/`,
    "",
    ""
  ].join("\r\n");
}
function buildByebyeNotify(device) {
  return [
    "NOTIFY * HTTP/1.1",
    "Host: 239.255.255.250:1900",
    "NT: roku:ecp",
    "NTS: ssdp:byebye",
    `USN: uuid:roku:ecp:${device.uuid}`,
    "",
    ""
  ].join("\r\n");
}
function buildAliveNotify(device, advertiseIp) {
  return [
    "NOTIFY * HTTP/1.1",
    "Host: 239.255.255.250:1900",
    `Cache-Control: max-age=${MAX_AGE}`,
    `LOCATION: http://${advertiseIp}:${device.port}/`,
    "NT: roku:ecp",
    "NTS: ssdp:alive",
    `Server: ${SERVER_SIG}`,
    `USN: uuid:roku:ecp:${device.uuid}`,
    "",
    ""
  ].join("\r\n");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildAliveNotify,
  buildByebyeNotify,
  buildSearchResponse,
  rokuSearchTarget
});
//# sourceMappingURL=ssdp-messages.js.map
