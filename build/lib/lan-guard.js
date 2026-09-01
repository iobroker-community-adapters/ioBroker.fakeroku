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
var lan_guard_exports = {};
__export(lan_guard_exports, {
  isLanClient: () => isLanClient
});
module.exports = __toCommonJS(lan_guard_exports);
function isLanClient(remoteAddress) {
  if (!remoteAddress) {
    return false;
  }
  const ip = remoteAddress.replace(/^::ffff:/, "");
  if (ip === "127.0.0.1" || ip === "::1") {
    return true;
  }
  if (/^10\./.test(ip)) {
    return true;
  }
  if (/^192\.168\./.test(ip)) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) {
    return true;
  }
  if (/^169\.254\./.test(ip)) {
    return true;
  }
  const v6 = ip.toLowerCase();
  if (/^fe[89ab][0-9a-f]:/.test(v6) || /^f[cd][0-9a-f]{2}:/.test(v6)) {
    return true;
  }
  return false;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  isLanClient
});
//# sourceMappingURL=lan-guard.js.map
