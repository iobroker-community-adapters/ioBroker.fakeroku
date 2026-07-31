import {
  DeviceManagement,
  type ActionContext,
  type DeviceInfo,
  type DeviceLoadContext,
  type JsonFormSchema,
} from "@iobroker/dm-utils";
import type { DeviceType } from "./ecp/state-model";
import { t } from "./lib/i18n";

const DEFAULT_PORT = 8060;

/** One emulated Roku as stored in the adapter's native.devices. */
interface RokuDeviceConfig {
  name: string;
  port: number;
  type: DeviceType;
}

/** Manager directive: reload the whole view. */
type InstanceResult = { refresh: boolean };
/** Manager directive: reload the device list. */
type DeviceResult = { refresh: "devices" };

/**
 * The add/edit form for one emulated Roku: name, ECP port and device type. Labels
 * are resolved translation objects so the embedded form is language-correct.
 *
 * @returns the jsonConfig panel schema for one device
 */
export function buildDeviceForm(): JsonFormSchema {
  return {
    type: "panel",
    items: {
      name: { type: "text", label: t("deviceName"), default: "Roku", sm: 12, md: 6 },
      port: { type: "number", label: t("devicePort"), default: DEFAULT_PORT, min: 1, max: 65535, sm: 12, md: 3 },
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
      _typeHint: { type: "staticText", text: t("deviceTypeHint"), sm: 12 },
    },
  } as unknown as JsonFormSchema;
}

/**
 * Normalise raw form values into a clean RokuDeviceConfig (trimmed name, numeric
 * port, valid type) so native.devices stays tidy.
 *
 * @param raw the submitted form values
 * @returns the normalised device config
 */
export function cleanDevice(raw: Record<string, unknown>): RokuDeviceConfig {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const port = Number(raw.port) || DEFAULT_PORT;
  const type: DeviceType = raw.type === "tv" ? "tv" : "player";
  return { name, port, type };
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
   * Build one device card (name + type/port subtitle) with edit/delete actions.
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
      manufacturer: "Roku",
      model: `${kind} · port ${device.port || DEFAULT_PORT}`,
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
   * The "+ add" action above the list.
   *
   * @returns the instance action descriptor
   */
  protected getInstanceInfo(): ReturnType<DeviceManagement["getInstanceInfo"]> {
    return {
      apiVersion: "v3",
      actions: [{ id: "add", icon: "add", description: t("dmAdd"), handler: async context => this.addDevice(context) }],
    };
  }

  /**
   * Manual add: show the empty form and append a named result.
   *
   * @param context the action context
   * @returns a directive to reload the manager
   */
  private async addDevice(context: ActionContext): Promise<InstanceResult> {
    const data = await context.showForm(buildDeviceForm(), {
      title: t("dmAdd"),
      data: { type: "player", port: DEFAULT_PORT },
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
  private async editDevice(index: number, context: ActionContext): Promise<DeviceResult> {
    const devices = await this.readDevices();
    const current = devices[index];
    if (!current) {
      return { refresh: "devices" };
    }
    const data = await context.showForm(buildDeviceForm(), { title: t("dmEditTitle"), data: { ...current } });
    if (data && typeof data.name === "string" && data.name.trim()) {
      devices[index] = cleanDevice(data);
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
