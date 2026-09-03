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
var object_cleanup_exports = {};
__export(object_cleanup_exports, {
  planObjectCleanup: () => planObjectCleanup
});
module.exports = __toCommonJS(object_cleanup_exports);
var import_constants = require("./constants");
function planObjectCleanup(existingIds, configuredDeviceIds, validKeysByDevice) {
  const del = /* @__PURE__ */ new Set();
  for (const id of existingIds) {
    const parts = id.split(".");
    const device = parts[0];
    if (import_constants.OWN_INFO_IDS.has(id)) {
      continue;
    }
    if (device === "info") {
      const child = `info.${parts[1]}`;
      if (!import_constants.OWN_INFO_IDS.has(child)) {
        del.add(child);
      }
      continue;
    }
    if (!configuredDeviceIds.has(device)) {
      del.add(device);
      continue;
    }
    if (parts[1] === "apps") {
      del.add(`${device}.apps`);
    } else if (parts[1] === "keys" && parts.length === 3) {
      const valid = validKeysByDevice.get(device);
      if (valid && !valid.has(parts[2])) {
        del.add(`${device}.keys.${parts[2]}`);
      }
    }
  }
  return [...del];
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  planObjectCleanup
});
//# sourceMappingURL=object-cleanup.js.map
