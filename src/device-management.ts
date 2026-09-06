import {
  DeviceManagement,
  type ActionContext,
  type DeviceInfo,
  type DeviceLoadContext,
  type JsonFormSchema,
} from "@iobroker/dm-utils";
import { RESERVED_IDS } from "./lib/constants";
import {
  findClash,
  nextFreePort,
  normalizePort,
  normalizeType,
  toDeviceRows,
  type DeviceRow,
} from "./lib/device-config";
import { deriveUuid } from "./lib/device-identity";
import { t } from "./lib/i18n";
import { sanitizeId } from "./lib/pure-helpers";

/**
 * One emulated Roku as stored in the adapter's native.devices — the manifest's own
 * element type, so the manager and the runtime (main.ts) read the same shape.
 * `uuid` is the stable SSDP identity, carried through edits so the pairing survives.
 */
type RokuDeviceConfig = ioBroker.AdapterConfig["devices"][number];

/** Manager directive: reload the whole view. */
type InstanceResult = { refresh: boolean };
/** Manager directive: reload the device list. */
type DeviceResult = { refresh: "devices" };

/**
 * The object id a name would take, as JavaScript the admin evaluates inside a validator.
 * Mirrors `sanitizeId` (lib/pure-helpers.ts) — the dialog has to answer the same question
 * as the runtime, and it cannot call into the adapter's code.
 */
const ID_EXPRESSION = "(data.name||'').trim().replace(/[^A-Za-z0-9\\-_]/g,'_')";

/**
 * The add/edit form for one emulated Roku: name, ECP port and device type.
 *
 * The name validator answers all three name rules the backend knows — already taken,
 * reserved for the adapter's own tree, and "sanitizes to the same object id as another
 * device" — so the OK button greys out instead of the dialog accepting a name that the
 * backend then refuses after the round-trip. One field carries one error text, so it names
 * all three cases; `findClash` still returns the specific reason for anyone bypassing the
 * dialog. Labels are resolved translation objects so the embedded form is language-correct.
 *
 * @param usedNames names taken by OTHER devices (the edited device is excluded)
 * @param usedPorts ports taken by OTHER devices
 * @returns the jsonConfig panel schema for one device
 */
export function buildDeviceForm(usedNames: readonly string[], usedPorts: readonly number[]): JsonFormSchema {
  const nameList = JSON.stringify(usedNames.map(n => n.trim().toLowerCase()));
  // Reserved ids first, then the object ids the other devices already occupy.
  const idList = JSON.stringify([...RESERVED_IDS, ...usedNames.map(n => sanitizeId(n.trim()))]);
  const portList = JSON.stringify([...usedPorts]);
  return {
    type: "panel",
    items: {
      name: {
        type: "text",
        label: t("deviceName"),
        validator:
          `${ID_EXPRESSION}.length>0` +
          ` && !${nameList}.includes((data.name||'').trim().toLowerCase())` +
          ` && !${idList}.includes(${ID_EXPRESSION})`,
        validatorErrorText: t("deviceNameRejected"),
        validatorNoSaveOnError: true,
        sm: 12,
        md: 6,
      },
      port: {
        type: "number",
        label: t("devicePort"),
        min: 1,
        max: 65535,
        validator: `!${portList}.includes(Number(data.port))`,
        validatorErrorText: t("devicePortInUse"),
        validatorNoSaveOnError: true,
        sm: 12,
        md: 3,
      },
      type: {
        type: "select",
        label: t("deviceTypeLabel"),
        default: "player",
        options: [
          { label: t("deviceTypePlayer"), value: "player" },
          { label: t("deviceTypeTv"), value: "tv" },
        ],
        sm: 12,
        md: 3,
      },
      _portHint: { type: "staticText", text: t("devicePortHint"), sm: 12 },
      _typeHint: { type: "staticText", text: t("deviceTypeHint"), sm: 12 },
    },
  } as unknown as JsonFormSchema;
}

/**
 * Normalise raw form values into a clean device (trimmed name, valid port, valid type) so
 * native.devices stays tidy. Same rules as reading a stored row (lib/device-config.ts), the
 * uuid is set by the caller.
 *
 * @param raw the submitted form values
 * @returns the normalised device config (without uuid)
 */
export function cleanDevice(raw: Record<string, unknown>): Omit<RokuDeviceConfig, "uuid"> {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  return { name, port: normalizePort(raw.port), type: normalizeType(raw.type) };
}

/**
 * ioBroker device-manager backend: the emulated Rokus as cards with manual
 * add/edit/delete — no scan, the devices are purely user-defined. Owns no state;
 * it reads and writes the adapter's own `native.devices` config array.
 */
export class FakerokuDeviceManagement extends DeviceManagement {
  private get objId(): string {
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
  private async readDevices(): Promise<DeviceRow[]> {
    const obj = await this.adapter.getForeignObjectAsync(this.objId);
    const devices = (obj?.native as { devices?: unknown } | undefined)?.devices;
    return toDeviceRows(devices) ?? [];
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
  private async writeDevices(devices: RokuDeviceConfig[]): Promise<void> {
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
  private static toStored(row: DeviceRow): RokuDeviceConfig {
    return { name: row.storedName, port: row.port, type: row.type, uuid: row.identity };
  }

  /**
   * Populate the manager with one card per configured device.
   *
   * @param context the load context
   */
  protected async loadDevices(context: DeviceLoadContext<string>): Promise<void> {
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
  private toDeviceInfo(device: DeviceRow): DeviceInfo<string> {
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
          description: t("dmEdit"),
          handler: async (id: string, context: ActionContext) => this.editDevice(id, context),
        },
        {
          id: "delete",
          icon: "delete",
          description: t("dmDelete"),
          handler: async (id: string, context: ActionContext) => this.deleteDevice(id, context),
        },
      ],
    };
  }

  /**
   * The "+ add" action above the list, plus the label for the port shown on each card.
   *
   * @returns the instance action descriptor
   */
  protected getInstanceInfo(): ReturnType<DeviceManagement["getInstanceInfo"]> {
    return {
      apiVersion: "v3",
      identifierLabel: t("portLabel"),
      actions: [{ id: "add", icon: "add", description: t("dmAdd"), handler: async context => this.addDevice(context) }],
    };
  }

  /**
   * Manual add: pre-select a free port, show the form, and append the device with
   * a stable derived uuid.
   *
   * @param context the action context
   * @returns a directive to reload the manager
   */
  private async addDevice(context: ActionContext): Promise<InstanceResult> {
    const devices = await this.readDevices();
    const usedNames = devices.map(d => d.name);
    const usedPorts = devices.map(d => d.port);
    const data = await context.showForm(buildDeviceForm(usedNames, usedPorts), {
      title: t("dmAdd"),
      data: { type: "player", port: nextFreePort(usedPorts) },
    });
    if (data && typeof data.name === "string" && data.name.trim()) {
      const clean = cleanDevice(data);
      const clash = findClash(devices, clean, -1);
      if (clash) {
        await context.showMessage(clash);
        return { refresh: true };
      }
      const stored = devices.map(d => FakerokuDeviceManagement.toStored(d));
      stored.push({ ...clean, uuid: deriveUuid(clean.name) });
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
  private async editDevice(cardId: string, context: ActionContext): Promise<DeviceResult> {
    const devices = await this.readDevices();
    const index = devices.findIndex(d => d.identity === cardId);
    const current = devices[index];
    if (!current) {
      return { refresh: "devices" };
    }
    const usedNames = devices.filter((_, i) => i !== index).map(d => d.name);
    const usedPorts = devices.filter((_, i) => i !== index).map(d => d.port);
    const data = await context.showForm(buildDeviceForm(usedNames, usedPorts), {
      title: t("dmEditTitle"),
      data: { name: current.name, port: current.port, type: current.type },
    });
    if (data && typeof data.name === "string" && data.name.trim()) {
      const clean = cleanDevice(data);
      const clash = findClash(devices, clean, index);
      if (clash) {
        await context.showMessage(clash);
        return { refresh: "devices" };
      }
      const stored = devices.map(d => FakerokuDeviceManagement.toStored(d));
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
  private async deleteDevice(cardId: string, context: ActionContext): Promise<DeviceResult> {
    const devices = await this.readDevices();
    const index = devices.findIndex(d => d.identity === cardId);
    const target = devices[index];
    if (!target) {
      return { refresh: "devices" };
    }
    const confirmed = await context.showConfirmation(t("dmDeleteConfirm", target.name));
    if (confirmed) {
      const stored = devices.map(d => FakerokuDeviceManagement.toStored(d));
      stored.splice(index, 1);
      await this.writeDevices(stored);
    }
    return { refresh: "devices" };
  }
}
