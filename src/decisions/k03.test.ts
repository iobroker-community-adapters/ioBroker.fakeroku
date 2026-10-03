// Guard of K3 (krobi 2026-10-02 23:52, taken over): the object id of an emulated Roku is fixed — renaming changes only
// the displayed name. Sealed in the register — a change goes through the Werkbank.
import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/i18n", () => ({
  t: (key: string, ...args: unknown[]) => (args.length > 0 ? `${key}(${args.join(",")})` : key),
  tName: (key: string) => ({ en: key }),
  tDesc: (key: string) => ({ en: key }),
  tRaw: (text: string) => ({ en: text }),
}));

import { FakerokuDeviceManagement } from "../device-management";
import { toDeviceRow } from "../lib/device-config";

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

describe("K3 — the object id stays when a Roku is renamed", () => {
  it("keeps the object id through a rename in the device manager", async () => {
    const store: Store = {
      devices: [
        {
          name: "Wohnzimmer",
          port: 8060,
          type: "player",
          uuid: "0123456789abcdef0123456789abcdef",
          objectId: "Wohnzimmer",
        },
      ],
    };
    await managerOver(store).editDevice(
      "0123456789abcdef0123456789abcdef",
      dialogs({ name: "Kino", port: 8060, type: "player" }),
    );
    expect(store.devices[0]).toMatchObject({ name: "Kino", objectId: "Wohnzimmer" });
  });

  it("builds the tree under the stored object id, whatever the name is now", () => {
    expect(toDeviceRow({ name: "Kino", objectId: "Wohnzimmer" })!.objectId).toBe("Wohnzimmer");
  });
});
