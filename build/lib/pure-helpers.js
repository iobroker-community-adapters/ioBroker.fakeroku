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
var pure_helpers_exports = {};
__export(pure_helpers_exports, {
  normalizeKey: () => normalizeKey,
  sanitizeId: () => sanitizeId
});
module.exports = __toCommonJS(pure_helpers_exports);
function sanitizeId(raw) {
  return raw.replace(/[^A-Za-z0-9\-_]/g, "_");
}
function normalizeKey(raw) {
  const decoded = raw.startsWith("Lit_") ? `Lit_${decodeURIComponent(raw.slice(4))}` : raw;
  return decoded.replace(/\./g, "_");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  normalizeKey,
  sanitizeId
});
//# sourceMappingURL=pure-helpers.js.map
