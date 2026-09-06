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
var device_config_exports = {};
__export(device_config_exports, {
  deviceObjectId: () => deviceObjectId,
  findClash: () => findClash,
  nextFreePort: () => nextFreePort,
  normalizePort: () => normalizePort,
  normalizeType: () => normalizeType,
  toDeviceRow: () => toDeviceRow,
  toDeviceRows: () => toDeviceRows
});
module.exports = __toCommonJS(device_config_exports);
var import_constants = require("./constants");
var import_device_identity = require("./device-identity");
var import_i18n = require("./i18n");
var import_pure_helpers = require("./pure-helpers");
const MIN_PORT = 1;
const MAX_PORT = 65535;
function normalizePort(value) {
  const port = Math.trunc(Number(value));
  return Number.isFinite(port) && port >= MIN_PORT && port <= MAX_PORT ? port : import_constants.DEFAULT_ECP_PORT;
}
function normalizeType(value) {
  return value === "tv" ? "tv" : "player";
}
function toDeviceRow(raw) {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const row = raw;
  if (typeof row.name !== "string" || row.name.trim().length === 0) {
    return null;
  }
  const identity = (0, import_device_identity.resolveDeviceUuid)({ name: row.name, uuid: row.uuid });
  const port = normalizePort(row.port);
  return {
    storedName: row.name,
    name: row.name.trim(),
    port,
    type: normalizeType(row.type),
    identity,
    identityReplaced: typeof row.uuid === "string" && row.uuid.length > 0 && row.uuid !== identity,
    portReplaced: row.port !== void 0 && port !== Number(row.port)
  };
}
function toDeviceRows(devices) {
  if (!Array.isArray(devices)) {
    return null;
  }
  const rows = [];
  for (const raw of devices) {
    const row = toDeviceRow(raw);
    if (row) {
      rows.push(row);
    }
  }
  return rows;
}
function deviceObjectId(row) {
  return (0, import_pure_helpers.sanitizeId)(row.storedName);
}
function nextFreePort(usedPorts) {
  const taken = new Set(usedPorts);
  let port = import_constants.DEFAULT_ECP_PORT;
  while (taken.has(port)) {
    port++;
  }
  return port;
}
function findClash(devices, candidate, exceptIndex) {
  const name = candidate.name.trim().toLowerCase();
  const id = (0, import_pure_helpers.sanitizeId)(candidate.name.trim());
  if (id === "" || import_constants.RESERVED_IDS.has(id)) {
    return (0, import_i18n.t)("deviceNameInvalid");
  }
  for (let i = 0; i < devices.length; i++) {
    if (i === exceptIndex) {
      continue;
    }
    if (devices[i].name.trim().toLowerCase() === name) {
      return (0, import_i18n.t)("deviceNameInUse");
    }
    if ((0, import_pure_helpers.sanitizeId)(devices[i].name.trim()) === id) {
      return (0, import_i18n.t)("deviceNameInvalid");
    }
    if (Number(devices[i].port) === candidate.port) {
      return (0, import_i18n.t)("devicePortInUse");
    }
  }
  return null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  deviceObjectId,
  findClash,
  nextFreePort,
  normalizePort,
  normalizeType,
  toDeviceRow,
  toDeviceRows
});
//# sourceMappingURL=device-config.js.map
