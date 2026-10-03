// Guard of K13 (krobi 2026-10-03 00:02, taken over): deleting a Roku in the device manager asks first; afterwards its
// datapoints are gone. Sealed in the register — a change goes through the Werkbank.
import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/i18n", () => ({
  t: (key: string, ...args: unknown[]) => (args.length > 0 ? `${key}(${args.join(",")})` : key),
  tName: (key: string) => ({ en: key }),
  tDesc: (key: string) => ({ en: key }),
  tRaw: (text: string) => ({ en: text }),
}));

import { FakerokuDeviceManagement } from "../device-management";
import { planObjectCleanup } from "../lib/object-cleanup";

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

const kino = { name: "Kino", port: 8060, type: "player", uuid: "0123456789abcdef0123456789abcdef", objectId: "Kino" };
const kueche = {
  name: "Kueche",
  port: 8061,
  type: "player",
  uuid: "fedcba9876543210fedcba9876543210",
  objectId: "Kueche",
};

describe("K13 — delete asks, then the datapoints are gone", () => {
  it("asks before it deletes, naming the Roku, and keeps it when the answer is no", async () => {
    const store: Store = { devices: [structuredClone(kino), structuredClone(kueche)] };
    const asked = dialogs(undefined, false);
    await managerOver(store).deleteDevice(kino.uuid, asked);
    expect(asked.shown).toEqual(["dmDeleteConfirm(Kino)"]);
    expect(store.devices.map(d => d.name)).toEqual(["Kino", "Kueche"]);
  });

  it("removes it from the settings after a yes", async () => {
    const store: Store = { devices: [structuredClone(kino), structuredClone(kueche)] };
    await managerOver(store).deleteDevice(kino.uuid, dialogs(undefined, true));
    expect(store.devices.map(d => d.name)).toEqual(["Kueche"]);
  });

  it("removes the deleted Roku's whole tree on the next start, and only that", () => {
    const plan = planObjectCleanup(
      ["Kino", "Kino.command", "Kino.keys", "Kino.keys.Home", "Kueche", "Kueche.command", "info", "info.connection"],
      new Set(["Kueche"]),
      new Map([["Kueche", new Set(["Home"])]]),
    );
    expect(plan).toEqual(["Kino"]);
  });
});
