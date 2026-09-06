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
var import_constants = require("./lib/constants");
var import_device_config = require("./lib/device-config");
var import_device_identity = require("./lib/device-identity");
var import_i18n = require("./lib/i18n");
var import_pure_helpers = require("./lib/pure-helpers");
const ID_EXPRESSION = "(data.name||'').trim().replace(/[^A-Za-z0-9\\-_]/g,'_')";
function buildDeviceForm(usedNames, usedPorts) {
  const nameList = JSON.stringify(usedNames.map((n) => n.trim().toLowerCase()));
  const idList = JSON.stringify([...import_constants.RESERVED_IDS, ...usedNames.map((n) => (0, import_pure_helpers.sanitizeId)(n.trim()))]);
  const portList = JSON.stringify([...usedPorts]);
  return {
    type: "panel",
    items: {
      name: {
        type: "text",
        label: (0, import_i18n.t)("deviceName"),
        validator: `${ID_EXPRESSION}.length>0 && !${nameList}.includes((data.name||'').trim().toLowerCase()) && !${idList}.includes(${ID_EXPRESSION})`,
        validatorErrorText: (0, import_i18n.t)("deviceNameRejected"),
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
  return { name, port: (0, import_device_config.normalizePort)(raw.port), type: (0, import_device_config.normalizeType)(raw.type) };
}
class FakerokuDeviceManagement extends import_dm_utils.DeviceManagement {
  get objId() {
    return `system.adapter.${this.adapter.namespace}`;
  }
  /**
   * Read the device list from the live config object, through the shared normaliser.
   *
   * Every row keeps BOTH names: the trimmed one the card shows and the next write stores,
   * and the stored one the identity was resolved from. Nothing here re-derives an identity
   * from the display name — that is what unpaired the remote before (lib/device-config.ts).
   *
   * @returns the configured devices (normalised), or an empty list
   */
  async readDevices() {
    var _a, _b;
    const obj = await this.adapter.getForeignObjectAsync(this.objId);
    const devices = (_a = obj == null ? void 0 : obj.native) == null ? void 0 : _a.devices;
    return (_b = (0, import_device_config.toDeviceRows)(devices)) != null ? _b : [];
  }
  /**
   * Persist the device list.
   *
   * ⚠️ The full array only replaces the stored one because the key is literally called
   * `devices`: js-controller clears the old array before merging for exactly four names
   * (`common.members`, `native.repositories`, `native.certificates`, `native.devices` —
   * adapter.ts `_extendForeignObject`). Under any other name `extend(true, …)` would merge
   * arrays element-wise, and deleting the second of two devices would leave both in place.
   * Renaming this config key silently breaks deletion; `device-management.test.ts` pins it.
   *
   * Writing `native.*` restarts the adapter, which re-creates the object trees and servers.
   *
   * @param devices the full device list to store
   */
  async writeDevices(devices) {
    await this.adapter.extendForeignObjectAsync(this.objId, { native: { devices } });
  }
  /**
   * The stored shape of a row the user did NOT touch: its name exactly as it was, the
   * normalised port and type, and the identity resolved when the row was read.
   *
   * The name stays untouched on purpose. Writing the trimmed form would move that device's
   * object id on the next start — a tree wandering, and every script pointing into it
   * breaking, because someone edited a different card. Trimming happens where the user
   * pressed save, nowhere else. Persisting the identity is safe by contrast: it is exactly
   * the value the runtime is already advertising for that row, just no longer derived.
   *
   * @param row the normalised row
   * @returns the row as it is persisted
   */
  static toStored(row) {
    return { name: row.storedName, port: row.port, type: row.type, uuid: row.identity };
  }
  /**
   * Populate the manager with one card per configured device.
   *
   * @param context the load context
   */
  async loadDevices(context) {
    const devices = await this.readDevices();
    for (const device of devices) {
      context.addDevice(this.toDeviceInfo(device));
    }
  }
  /**
   * Build one device card. The model (Player/TV) and the ECP port each get their
   * own line — the port via `identifier` (labelled in getInstanceInfo). No
   * manufacturer line: it is always "Roku" and tells the user nothing for an emulator.
   *
   * The card is keyed by the device's SSDP identity, not by its list position: a position
   * is only valid for as long as the view is fresh, so a second admin tab (or a list that
   * changed underneath) would send edit/delete to a different device than the card clicked.
   * Two hand-edited rows can share an identity; the first one wins, which is the same answer
   * the runtime gives when two names map to one object id.
   *
   * The name needs no fallback: a row without a usable one never becomes a DeviceRow
   * (lib/device-config.ts drops it), so `Roku <n>` was a branch nothing could reach —
   * the mutation run of 1.6.0 found it by having no test that could fail on its removal.
   *
   * @param device the stored device
   * @returns the card descriptor
   */
  toDeviceInfo(device) {
    const kind = device.type === "tv" ? "TV" : "Player";
    return {
      id: device.identity,
      name: device.name,
      identifier: String(device.port),
      model: kind,
      actions: [
        {
          id: "edit",
          icon: "edit",
          description: (0, import_i18n.t)("dmEdit"),
          handler: async (id, context) => this.editDevice(id, context)
        },
        {
          id: "delete",
          icon: "delete",
          description: (0, import_i18n.t)("dmDelete"),
          handler: async (id, context) => this.deleteDevice(id, context)
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
    const usedPorts = devices.map((d) => d.port);
    const data = await context.showForm(buildDeviceForm(usedNames, usedPorts), {
      title: (0, import_i18n.t)("dmAdd"),
      data: { type: "player", port: (0, import_device_config.nextFreePort)(usedPorts) }
    });
    if (data && typeof data.name === "string" && data.name.trim()) {
      const clean = cleanDevice(data);
      const clash = (0, import_device_config.findClash)(devices, clean, -1);
      if (clash) {
        await context.showMessage(clash);
        return { refresh: true };
      }
      const stored = devices.map((d) => FakerokuDeviceManagement.toStored(d));
      stored.push({ ...clean, uuid: (0, import_device_identity.deriveUuid)(clean.name) });
      await this.writeDevices(stored);
    }
    return { refresh: true };
  }
  /**
   * Edit a device via the pre-filled form. Its own name/port are excluded from
   * the clash check, and its identity is preserved so the pairing survives a rename.
   *
   * The identity comes from the row as it was READ (lib/device-config.ts resolves it from
   * the stored name), never derived here: deriving it from the name in the form would move
   * the SSDP identity on a plain rename — and deriving it from the trimmed stored name would
   * move it even when the user changed nothing at all.
   *
   * @param cardId the card's id — the device's identity
   * @param context the action context
   * @returns a directive to reload the list
   */
  async editDevice(cardId, context) {
    const devices = await this.readDevices();
    const index = devices.findIndex((d) => d.identity === cardId);
    const current = devices[index];
    if (!current) {
      return { refresh: "devices" };
    }
    const usedNames = devices.filter((_, i) => i !== index).map((d) => d.name);
    const usedPorts = devices.filter((_, i) => i !== index).map((d) => d.port);
    const data = await context.showForm(buildDeviceForm(usedNames, usedPorts), {
      title: (0, import_i18n.t)("dmEditTitle"),
      data: { name: current.name, port: current.port, type: current.type }
    });
    if (data && typeof data.name === "string" && data.name.trim()) {
      const clean = cleanDevice(data);
      const clash = (0, import_device_config.findClash)(devices, clean, index);
      if (clash) {
        await context.showMessage(clash);
        return { refresh: "devices" };
      }
      const stored = devices.map((d) => FakerokuDeviceManagement.toStored(d));
      stored[index] = { ...clean, uuid: current.identity };
      await this.writeDevices(stored);
    }
    return { refresh: "devices" };
  }
  /**
   * Delete a device after confirmation.
   *
   * @param cardId the card's id — the device's identity
   * @param context the action context
   * @returns a directive to reload the list
   */
  async deleteDevice(cardId, context) {
    const devices = await this.readDevices();
    const index = devices.findIndex((d) => d.identity === cardId);
    const target = devices[index];
    if (!target) {
      return { refresh: "devices" };
    }
    const confirmed = await context.showConfirmation((0, import_i18n.t)("dmDeleteConfirm", target.name));
    if (confirmed) {
      const stored = devices.map((d) => FakerokuDeviceManagement.toStored(d));
      stored.splice(index, 1);
      await this.writeDevices(stored);
    }
    return { refresh: "devices" };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FakerokuDeviceManagement,
  buildDeviceForm,
  cleanDevice
});
//# sourceMappingURL=device-management.js.map
