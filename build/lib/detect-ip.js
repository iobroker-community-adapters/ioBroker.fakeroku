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
  detectLocalIPv4s: () => detectLocalIPv4s,
  detectLocalIPv6Prefixes: () => detectLocalIPv6Prefixes,
  detectPrimaryIPv4: () => detectPrimaryIPv4,
  ipv6Prefix64: () => ipv6Prefix64,
  listLocalIPv6Prefixes: () => listLocalIPv6Prefixes,
  listNonInternalIPv4s: () => listNonInternalIPv4s,
  pickPrimaryIPv4: () => pickPrimaryIPv4
});
module.exports = __toCommonJS(detect_ip_exports);
var import_node_os = require("node:os");
function isRoutableIPv4(addr) {
  return addr.family === "IPv4" && !addr.internal;
}
function listNonInternalIPv4s(interfaces) {
  const out = [];
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs != null ? addrs : []) {
      if (isRoutableIPv4(addr)) {
        out.push(addr.address);
      }
    }
  }
  return out;
}
const CONTAINER_BRIDGE_PREFIXES = ["172.17.", "172.18."];
function isContainerBridge(address) {
  return CONTAINER_BRIDGE_PREFIXES.some((prefix) => address.startsWith(prefix));
}
function pickPrimaryIPv4(interfaces) {
  var _a, _b;
  const addresses = listNonInternalIPv4s(interfaces);
  return (_b = (_a = addresses.find((address) => !isContainerBridge(address))) != null ? _a : addresses[0]) != null ? _b : "";
}
function detectPrimaryIPv4() {
  return pickPrimaryIPv4((0, import_node_os.networkInterfaces)());
}
function detectLocalIPv4s() {
  return listNonInternalIPv4s((0, import_node_os.networkInterfaces)());
}
function expandIPv6(address) {
  const bare = address.toLowerCase().split("%")[0];
  if (!bare.includes(":") || bare.includes(".")) {
    return null;
  }
  const halves = bare.split("::");
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? halves[1] ? halves[1].split(":") : [] : [];
  const groups = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail] : head;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) {
    return null;
  }
  return groups.map((g) => g.padStart(4, "0"));
}
function ipv6Prefix64(address) {
  const groups = expandIPv6(address);
  return groups ? groups.slice(0, 4).join(":") : null;
}
function listLocalIPv6Prefixes(interfaces) {
  const out = /* @__PURE__ */ new Set();
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs != null ? addrs : []) {
      if (addr.family !== "IPv6" || addr.internal) {
        continue;
      }
      const prefix = ipv6Prefix64(addr.address);
      if (prefix) {
        out.add(prefix);
      }
    }
  }
  return [...out];
}
function detectLocalIPv6Prefixes() {
  return listLocalIPv6Prefixes((0, import_node_os.networkInterfaces)());
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  detectLocalIPv4s,
  detectLocalIPv6Prefixes,
  detectPrimaryIPv4,
  ipv6Prefix64,
  listLocalIPv6Prefixes,
  listNonInternalIPv4s,
  pickPrimaryIPv4
});
//# sourceMappingURL=detect-ip.js.map
