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
var device_management_exports = {};
__export(device_management_exports, {
  FakerokuDeviceManagement: () => FakerokuDeviceManagement,
  buildDeviceForm: () => buildDeviceForm,
  cleanDevice: () => cleanDevice,
  findClash: () => findClash,
  nextFreePort: () => nextFreePort
});
module.exports = __toCommonJS(device_management_exports);
var import_dm_utils = require("@iobroker/dm-utils");
var import_constants = require("./lib/constants");
var import_device_identity = require("./lib/device-identity");
var import_i18n = require("./lib/i18n");
var import_pure_helpers = require("./lib/pure-helpers");
const RESERVED_IDS = /* @__PURE__ */ new Set(["info"]);
function nextFreePort(usedPorts) {
  const taken = new Set(usedPorts);
  let port = import_constants.DEFAULT_ECP_PORT;
  while (taken.has(port)) {
    port++;
  }
  return port;
}
function buildDeviceForm(usedNames, usedPorts) {
  const nameList = JSON.stringify(usedNames.map((n) => n.trim().toLowerCase()));
  const portList = JSON.stringify([...usedPorts]);
  return {
    type: "panel",
    items: {
      name: {
        type: "text",
        label: (0, import_i18n.t)("deviceName"),
        validator: `!${nameList}.includes((data.name||'').trim().toLowerCase())`,
        validatorErrorText: (0, import_i18n.t)("deviceNameInUse"),
        validatorNoSaveOnError: true,
        sm: 12,
        md: 6
      },
      port: {
        type: "number",
        label: (0, import_i18n.t)("devicePort"),
        min: 1,
        max: 65535,
        validator: `!${portList}.includes(Number(data.port))`,
        validatorErrorText: (0, import_i18n.t)("devicePortInUse"),
        validatorNoSaveOnError: true,
        sm: 12,
        md: 3
      },
      type: {
        type: "select",
        label: (0, import_i18n.t)("deviceTypeLabel"),
        default: "player",
        options: [
          { label: (0, import_i18n.t)("deviceTypePlayer"), value: "player" },
          { label: (0, import_i18n.t)("deviceTypeTv"), value: "tv" }
        ],
        sm: 12,
        md: 3
      },
      _portHint: { type: "staticText", text: (0, import_i18n.t)("devicePortHint"), sm: 12 },
      _typeHint: { type: "staticText", text: (0, import_i18n.t)("deviceTypeHint"), sm: 12 }
    }
  };
}
function cleanDevice(raw) {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const port = Number(raw.port) || import_constants.DEFAULT_ECP_PORT;
  const type = raw.type === "tv" ? "tv" : "player";
  return { name, port, type };
}
function findClash(devices, candidate, exceptIndex) {
  const name = candidate.name.trim().toLowerCase();
  const id = (0, import_pure_helpers.sanitizeId)(candidate.name.trim());
  if (id === "" || RESERVED_IDS.has(id)) {
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
class FakerokuDeviceManagement extends import_dm_utils.DeviceManagement {
  get objId() {
    return `system.adapter.${this.adapter.namespace}`;
  }
  /**
   * Read the device list from the live config object.
   *
   * @returns the configured devices (normalised), or an empty list
   */
  async readDevices() {
    var _a;
    const obj = await this.adapter.getForeignObjectAsync(this.objId);
    const devices = (_a = obj == null ? void 0 : obj.native) == null ? void 0 : _a.devices;
    if (!Array.isArray(devices)) {
      return [];
    }
    return devices.filter((d) => typeof d === "object" && d !== null).map((d) => {
      const clean = cleanDevice(d);
      return typeof d.uuid === "string" && d.uuid ? { ...clean, uuid: d.uuid } : clean;
    });
  }
  /**
   * Persist the device list. Writing `native.*` restarts the adapter, which
   * re-creates the object trees and servers with the new devices.
   *
   * @param devices the full device list to store
   */
  async writeDevices(devices) {
    await this.adapter.extendForeignObjectAsync(this.objId, { native: { devices } });
  }
  /**
   * Populate the manager with one card per configured device.
   *
   * @param context the load context
   */
  async loadDevices(context) {
    const devices = await this.readDevices();
    devices.forEach((device, index) => context.addDevice(this.toDeviceInfo(device, index)));
  }
  /**
   * Build one device card. The model (Player/TV) and the ECP port each get their
   * own line — the port via `identifier` (labelled in getInstanceInfo). No
   * manufacturer line: it is always "Roku" and tells the user nothing for an emulator.
   * The row comes from readDevices(), so the port is already a number; only the name
   * can still be empty (a row saved without one) and gets a numbered stand-in.
   *
   * @param device the stored device
   * @param index its list position — the (per-session stable) card id
   * @returns the card descriptor
   */
  toDeviceInfo(device, index) {
    const kind = device.type === "tv" ? "TV" : "Player";
    return {
      id: String(index),
      name: device.name || `Roku ${index + 1}`,
      identifier: String(device.port),
      model: kind,
      actions: [
        {
          id: "edit",
          icon: "edit",
          description: (0, import_i18n.t)("dmEdit"),
          handler: async (id, context) => this.editDevice(Number(id), context)
        },
        {
          id: "delete",
          icon: "delete",
          description: (0, import_i18n.t)("dmDelete"),
          handler: async (id, context) => this.deleteDevice(Number(id), context)
        }
      ]
    };
  }
  /**
   * The "+ add" action above the list, plus the label for the port shown on each card.
   *
   * @returns the instance action descriptor
   */
  getInstanceInfo() {
    return {
      apiVersion: "v3",
      identifierLabel: (0, import_i18n.t)("portLabel"),
      actions: [{ id: "add", icon: "add", description: (0, import_i18n.t)("dmAdd"), handler: async (context) => this.addDevice(context) }]
    };
  }
  /**
   * Manual add: pre-select a free port, show the form, and append the device with
   * a stable derived uuid.
   *
   * @param context the action context
   * @returns a directive to reload the manager
   */
  async addDevice(context) {
    const devices = await this.readDevices();
    const usedNames = devices.map((d) => d.name);
    const usedPorts = devices.map((d) => Number(d.port));
    const data = await context.showForm(buildDeviceForm(usedNames, usedPorts), {
      title: (0, import_i18n.t)("dmAdd"),
      data: { type: "player", port: nextFreePort(usedPorts) }
    });
    if (data && typeof data.name === "string" && data.name.trim()) {
      const clean = cleanDevice(data);
      const clash = findClash(devices, clean, -1);
      if (clash) {
        await context.showMessage(clash);
        return { refresh: true };
      }
      devices.push({ ...clean, uuid: (0, import_device_identity.deriveUuid)(clean.name) });
      await this.writeDevices(devices);
    }
    return { refresh: true };
  }
  /**
   * Edit a device via the pre-filled form. Its own name/port are excluded from
   * the clash check, and its uuid is preserved so the pairing survives a rename.
   *
   * @param index the device's list position
   * @param context the action context
   * @returns a directive to reload the list
   */
  async editDevice(index, context) {
    const devices = await this.readDevices();
    const current = devices[index];
    if (!current) {
      return { refresh: "devices" };
    }
    const usedNames = devices.filter((_, i) => i !== index).map((d) => d.name);
    const usedPorts = devices.filter((_, i) => i !== index).map((d) => Number(d.port));
    const data = await context.showForm(buildDeviceForm(usedNames, usedPorts), {
      title: (0, import_i18n.t)("dmEditTitle"),
      data: { ...current }
    });
    if (data && typeof data.name === "string" && data.name.trim()) {
      const clean = cleanDevice(data);
      const clash = findClash(devices, clean, index);
      if (clash) {
        await context.showMessage(clash);
        return { refresh: "devices" };
      }
      devices[index] = { ...clean, uuid: current.uuid || (0, import_device_identity.deriveUuid)(clean.name) };
      await this.writeDevices(devices);
    }
    return { refresh: "devices" };
  }
  /**
   * Delete a device after confirmation.
   *
   * @param index the device's list position
   * @param context the action context
   * @returns a directive to reload the list
   */
  async deleteDevice(index, context) {
    const devices = await this.readDevices();
    const target = devices[index];
    if (!target) {
      return { refresh: "devices" };
    }
    const confirmed = await context.showConfirmation((0, import_i18n.t)("dmDeleteConfirm", target.name || ""));
    if (confirmed) {
      devices.splice(index, 1);
      await this.writeDevices(devices);
    }
    return { refresh: "devices" };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FakerokuDeviceManagement,
  buildDeviceForm,
  cleanDevice,
  findClash,
  nextFreePort
});
//# sourceMappingURL=device-management.js.map
