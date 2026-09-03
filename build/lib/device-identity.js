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
var device_identity_exports = {};
__export(device_identity_exports, {
  deriveUuid: () => deriveUuid,
  resolveDeviceUuid: () => resolveDeviceUuid
});
module.exports = __toCommonJS(device_identity_exports);
var import_node_crypto = require("node:crypto");
function deriveUuid(name) {
  return (0, import_node_crypto.createHash)("md5").update(`fakeroku:${name}`).digest("hex");
}
const UUID_SHAPE = /^[A-Za-z0-9-]{1,64}$/;
function resolveDeviceUuid(device) {
  return typeof device.uuid === "string" && UUID_SHAPE.test(device.uuid) ? device.uuid : deriveUuid(device.name);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  deriveUuid,
  resolveDeviceUuid
});
//# sourceMappingURL=device-identity.js.map
