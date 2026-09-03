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
var constants_exports = {};
__export(constants_exports, {
  DEFAULT_ECP_PORT: () => DEFAULT_ECP_PORT,
  OWN_INFO_IDS: () => OWN_INFO_IDS,
  RESERVED_IDS: () => RESERVED_IDS
});
module.exports = __toCommonJS(constants_exports);
const DEFAULT_ECP_PORT = 8060;
const RESERVED_IDS = /* @__PURE__ */ new Set(["info"]);
const OWN_INFO_IDS = /* @__PURE__ */ new Set(["info", "info.connection"]);
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_ECP_PORT,
  OWN_INFO_IDS,
  RESERVED_IDS
});
//# sourceMappingURL=constants.js.map
