// Guard of F-09 (noted 2026-07-30, taken over 2026-10-02 23:52): the ECP port is a free field per Roku, default 8060;
// there is no automatic assignment. Sealed in the register — a change goes through the Werkbank.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/i18n", () => ({
  t: (key: string, ...args: unknown[]) => (args.length > 0 ? `${key}(${args.join(",")})` : key),
  tName: (key: string) => ({ en: key }),
  tDesc: (key: string) => ({ en: key }),
  tRaw: (text: string) => ({ en: text }),
}));

import { buildDeviceForm, FakerokuDeviceManagement } from "../device-management";
import { toDeviceRows } from "../lib/device-config";

/** The instance's settings as the device manager reads and writes them. */
interface Store {
  devices: Record<string, unknown>[];
}

/**
 * The adapter members the device manager uses, over one stored device list.
 *
 * @param store the stored settings
 * @returns the adapter stand-in
 */
function adapterOver(store: Store): never {
  return {
    namespace: "fakeroku.0",
    on: () => {},
    getAdapterObjectsAsync: () => Promise.resolve({}),
    getForeignObjectAsync: () => Promise.resolve({ native: { devices: structuredClone(store.devices) } }),
    extendForeignObjectAsync: (_id: string, patch: { native: { devices: Record<string, unknown>[] } }) => {
      store.devices = patch.native.devices;
      return Promise.resolve();
    },
  } as never;
}

/** The dialogs a device-manager action opens, answered by the test. */
interface Dialogs {
  showForm: (schema: unknown, options: { data: Record<string, unknown> }) => Promise<unknown>;
  showConfirmation: (text: unknown) => Promise<boolean>;
  showMessage: (text: unknown) => Promise<void>;
}

/**
 * Dialogs with fixed answers.
 *
 * @param form what the form returns
 * @param confirm what the confirmation returns
 * @returns the dialogs, with what they were shown
 */
function dialogs(form: unknown, confirm = true): Dialogs & { shown: unknown[] } {
  const shown: unknown[] = [];
  return {
    shown,
    showForm: (_schema, options) => {
      shown.push(options);
      return Promise.resolve(form);
    },
    showConfirmation: text => {
      shown.push(text);
      return Promise.resolve(confirm);
    },
    showMessage: () => Promise.resolve(),
  };
}

/** The private actions of the manager the guards drive. */
interface Actions {
  editDevice(cardId: string, context: Dialogs): Promise<unknown>;
  deleteDevice(cardId: string, context: Dialogs): Promise<unknown>;
  addDevice(context: Dialogs): Promise<unknown>;
  loadDevices(context: { addDevice: (card: { id: string; name: string }) => void }): Promise<void>;
}

/**
 * A device manager over a stored list.
 *
 * @param store the stored settings
 * @returns its actions
 */
function managerOver(store: Store): Actions {
  return new FakerokuDeviceManagement(adapterOver(store)) as unknown as Actions;
}

describe("F-09 — a port field per Roku, default 8060, no automatic assignment", () => {
  it("offers the port as a field of its own in the device dialog", () => {
    const items = (buildDeviceForm([], [], []).schema as unknown as { items: Record<string, { type: string }> }).items;
    expect(items.port.type).toBe("number");
  });

  it("ships the default Roku on 8060 and starts a new Roku's dialog on 8060", async () => {
    const io = JSON.parse(readFileSync(join(__dirname, "..", "..", "io-package.json"), "utf8")) as {
      native: { devices: { port: number }[] };
    };
    expect(io.native.devices.map(d => d.port)).toEqual([8060]);
    const asked = dialogs(undefined);
    await managerOver({ devices: [] }).addDevice(asked);
    expect((asked.shown[0] as { data: { port: number } }).data.port).toBe(8060);
  });

  it("runs every Roku on the port stored for it — nothing is reassigned", () => {
    const rows = toDeviceRows([
      { name: "A", port: 9000, type: "player" },
      { name: "B", port: 8060, type: "tv" },
    ]);
    expect(rows!.map(r => r.port)).toEqual([9000, 8060]);
  });
});
