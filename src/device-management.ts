import {
  DeviceManagement,
  type ActionContext,
  type DeviceInfo,
  type DeviceLoadContext,
  type JsonFormSchema,
} from "@iobroker/dm-utils";
import { deriveUuid } from "./lib/device-identity";
import type { DeviceType } from "./ecp/state-model";
import { t } from "./lib/i18n";

const DEFAULT_PORT = 8060;

/** One emulated Roku as stored in the adapter's native.devices. */
interface RokuDeviceConfig {
  name: string;
  port: number;
  type: DeviceType;
  /** Stable SSDP identity — carried through edits so the controller pairing survives. */
  uuid?: string;
}

/** Manager directive: reload the whole view. */
type InstanceResult = { refresh: boolean };
/** Manager directive: reload the device list. */
type DeviceResult = { refresh: "devices" };

/**
 * The lowest free ECP port at or above the real-Roku default, so a newly added
 * device never pre-selects a port another emulated Roku already uses.
 *
 * @param usedPorts the ports already taken by other devices
 * @returns the first free port >= 8060
 */
export function nextFreePort(usedPorts: readonly number[]): number {
  const taken = new Set(usedPorts);
  let port = DEFAULT_PORT;
  while (taken.has(port)) {
    port++;
  }
  return port;
}

/**
 * The add/edit form for one emulated Roku: name, ECP port and device type. The
 * name and port carry a live validator against the values already in use (the
 * OK button greys out on a clash); a hint explains that each Roku needs its own
 * port. Labels are resolved translation objects so the embedded form is
 * language-correct.
 *
 * @param usedNames names taken by OTHER devices (the edited device is excluded)
 * @param usedPorts ports taken by OTHER devices
 * @returns the jsonConfig panel schema for one device
 */
export function buildDeviceForm(usedNames: readonly string[], usedPorts: readonly number[]): JsonFormSchema {
  const nameList = JSON.stringify(usedNames.map(n => n.trim().toLowerCase()));
  const portList = JSON.stringify([...usedPorts]);
  return {
    type: "panel",
    items: {
      name: {
        type: "text",
        label: t("deviceName"),
        validator: `!${nameList}.includes((data.name||'').trim().toLowerCase())`,
        validatorErrorText: t("deviceNameInUse"),
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
 * Normalise raw form values into a clean device (trimmed name, numeric port,
 * valid type) so native.devices stays tidy. The uuid is set by the caller.
 *
 * @param raw the submitted form values
 * @returns the normalised device config (without uuid)
 */
export function cleanDevice(raw: Record<string, unknown>): Omit<RokuDeviceConfig, "uuid"> {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const port = Number(raw.port) || DEFAULT_PORT;
  const type: DeviceType = raw.type === "tv" ? "tv" : "player";
  return { name, port, type };
}

/**
 * A name/port clash against the other devices, as a ready-to-show message — the
 * backend safety net behind the form validator (the dialog validator may not
 * fire in every admin version; this never lets a duplicate through).
 *
 * @param devices the full current device list
 * @param candidate the name+port being added/edited
 * @param candidate.name the candidate device name
 * @param candidate.port the candidate ECP port
 * @param exceptIndex the list position to ignore (the device being edited), or -1
 * @returns a translated clash message, or null if free
 */
export function findClash(
  devices: readonly RokuDeviceConfig[],
  candidate: { name: string; port: number },
  exceptIndex: number,
): ioBroker.StringOrTranslated | null {
  const name = candidate.name.trim().toLowerCase();
  for (let i = 0; i < devices.length; i++) {
    if (i === exceptIndex) {
      continue;
    }
    if (devices[i].name.trim().toLowerCase() === name) {
      return t("deviceNameInUse");
    }
    if (Number(devices[i].port) === candidate.port) {
      return t("devicePortInUse");
    }
  }
  return null;
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
   * Read the device list from the live config object.
   *
   * @returns the configured devices, or an empty list
   */
  private async readDevices(): Promise<RokuDeviceConfig[]> {
    const obj = await this.adapter.getForeignObjectAsync(this.objId);
    const devices = (obj?.native as { devices?: unknown } | undefined)?.devices;
    return Array.isArray(devices) ? (devices as RokuDeviceConfig[]) : [];
  }

  /**
   * Persist the device list. Writing `native.*` restarts the adapter, which
   * re-creates the object trees and servers with the new devices.
   *
   * @param devices the full device list to store
   */
  private async writeDevices(devices: RokuDeviceConfig[]): Promise<void> {
    await this.adapter.extendForeignObjectAsync(this.objId, { native: { devices } });
  }

  /**
   * Populate the manager with one card per configured device.
   *
   * @param context the load context
   */
  protected async loadDevices(context: DeviceLoadContext<string>): Promise<void> {
    const devices = await this.readDevices();
    devices.forEach((device, index) => context.addDevice(this.toDeviceInfo(device, index)));
  }

  /**
   * Build one device card. The model (Player/TV) and the ECP port each get their
   * own line — the port via `identifier` (labelled in getInstanceInfo). No
   * manufacturer line: it is always "Roku" and tells the user nothing for an emulator.
   *
   * @param device the stored device
   * @param index its list position — the (per-session stable) card id
   * @returns the card descriptor
   */
  private toDeviceInfo(device: RokuDeviceConfig, index: number): DeviceInfo<string> {
    const kind = device.type === "tv" ? "TV" : "Player";
    return {
      id: String(index),
      name: device.name || `Roku ${index + 1}`,
      identifier: String(device.port || DEFAULT_PORT),
      model: kind,
      actions: [
        {
          id: "edit",
          icon: "edit",
          description: t("dmEdit"),
          handler: async (id: string, context: ActionContext) => this.editDevice(Number(id), context),
        },
        {
          id: "delete",
          icon: "delete",
          description: t("dmDelete"),
          handler: async (id: string, context: ActionContext) => this.deleteDevice(Number(id), context),
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
    const usedPorts = devices.map(d => Number(d.port));
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
      devices.push({ ...clean, uuid: deriveUuid(clean.name) });
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
  private async editDevice(index: number, context: ActionContext): Promise<DeviceResult> {
    const devices = await this.readDevices();
    const current = devices[index];
    if (!current) {
      return { refresh: "devices" };
    }
    const usedNames = devices.filter((_, i) => i !== index).map(d => d.name);
    const usedPorts = devices.filter((_, i) => i !== index).map(d => Number(d.port));
    const data = await context.showForm(buildDeviceForm(usedNames, usedPorts), {
      title: t("dmEditTitle"),
      data: { ...current },
    });
    if (data && typeof data.name === "string" && data.name.trim()) {
      const clean = cleanDevice(data);
      const clash = findClash(devices, clean, index);
      if (clash) {
        await context.showMessage(clash);
        return { refresh: "devices" };
      }
      devices[index] = { ...clean, uuid: current.uuid || deriveUuid(clean.name) };
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
  private async deleteDevice(index: number, context: ActionContext): Promise<DeviceResult> {
    const devices = await this.readDevices();
    const target = devices[index];
    if (!target) {
      return { refresh: "devices" };
    }
    const confirmed = await context.showConfirmation(t("dmDeleteConfirm", target.name || ""));
    if (confirmed) {
      devices.splice(index, 1);
      await this.writeDevices(devices);
    }
    return { refresh: "devices" };
  }
}
