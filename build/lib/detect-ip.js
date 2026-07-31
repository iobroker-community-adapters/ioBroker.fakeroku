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
var detect_ip_exports = {};
__export(detect_ip_exports, {
  detectPrimaryIPv4: () => detectPrimaryIPv4,
  pickPrimaryIPv4: () => pickPrimaryIPv4
});
module.exports = __toCommonJS(detect_ip_exports);
var import_node_os = require("node:os");
function pickPrimaryIPv4(interfaces) {
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs != null ? addrs : []) {
      const isV4 = addr.family === "IPv4" || addr.family === 4;
      if (isV4 && !addr.internal) {
        return addr.address;
      }
    }
  }
  return "";
}
function detectPrimaryIPv4() {
  return pickPrimaryIPv4((0, import_node_os.networkInterfaces)());
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  detectPrimaryIPv4,
  pickPrimaryIPv4
});
//# sourceMappingURL=detect-ip.js.map
