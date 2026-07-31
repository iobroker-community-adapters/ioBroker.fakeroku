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
  cleanDevice: () => cleanDevice
});
module.exports = __toCommonJS(device_management_exports);
var import_dm_utils = require("@iobroker/dm-utils");
var import_i18n = require("./lib/i18n");
const DEFAULT_PORT = 8060;
function buildDeviceForm() {
  return {
    type: "panel",
    items: {
      name: { type: "text", label: (0, import_i18n.t)("deviceName"), default: "Roku", sm: 12, md: 6 },
      port: { type: "number", label: (0, import_i18n.t)("devicePort"), default: DEFAULT_PORT, min: 1, max: 65535, sm: 12, md: 3 },
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
      _typeHint: { type: "staticText", text: (0, import_i18n.t)("deviceTypeHint"), sm: 12 }
    }
  };
}
function cleanDevice(raw) {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const port = Number(raw.port) || DEFAULT_PORT;
  const type = raw.type === "tv" ? "tv" : "player";
  return { name, port, type };
}
class FakerokuDeviceManagement extends import_dm_utils.DeviceManagement {
  get objId() {
    return `system.adapter.${this.adapter.namespace}`;
  }
  /**
   * Read the device list from the live config object.
   *
   * @returns the configured devices, or an empty list
   */
  async readDevices() {
    var _a;
    const obj = await this.adapter.getForeignObjectAsync(this.objId);
    const devices = (_a = obj == null ? void 0 : obj.native) == null ? void 0 : _a.devices;
    return Array.isArray(devices) ? devices : [];
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
   * Build one device card (name + type/port subtitle) with edit/delete actions.
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
      manufacturer: "Roku",
      model: `${kind} \xB7 port ${device.port || DEFAULT_PORT}`,
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
   * The "+ add" action above the list.
   *
   * @returns the instance action descriptor
   */
  getInstanceInfo() {
    return {
      apiVersion: "v3",
      actions: [{ id: "add", icon: "add", title: (0, import_i18n.t)("dmAdd"), handler: async (context) => this.addDevice(context) }]
    };
  }
  /**
   * Manual add: show the empty form and append a named result.
   *
   * @param context the action context
   * @returns a directive to reload the manager
   */
  async addDevice(context) {
    const data = await context.showForm(buildDeviceForm(), {
      title: (0, import_i18n.t)("dmAdd"),
      data: { type: "player", port: DEFAULT_PORT }
    });
    if (data && typeof data.name === "string" && data.name.trim()) {
      const devices = await this.readDevices();
      devices.push(cleanDevice(data));
      await this.writeDevices(devices);
    }
    return { refresh: true };
  }
  /**
   * Edit a device via the pre-filled form.
   *
   * @param index the device's list position
   * @param context the action context
   * @returns a directive to reload the list
   */
  async editDevice(index, context) {
    const devices = await this.readDevices();
    const current = devices[index];
    if (!current) {
      return { refresh: "instance" };
    }
    const data = await context.showForm(buildDeviceForm(), { title: (0, import_i18n.t)("dmEditTitle"), data: { ...current } });
    if (data && typeof data.name === "string" && data.name.trim()) {
      devices[index] = cleanDevice(data);
      await this.writeDevices(devices);
    }
    return { refresh: "instance" };
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
      return { refresh: "instance" };
    }
    const confirmed = await context.showConfirmation((0, import_i18n.t)("dmDeleteConfirm", target.name || ""));
    if (confirmed) {
      devices.splice(index, 1);
      await this.writeDevices(devices);
    }
    return { refresh: "instance" };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FakerokuDeviceManagement,
  buildDeviceForm,
  cleanDevice
});
//# sourceMappingURL=device-management.js.map
