// Guard of K7 (krobi 2026-10-02 23:52, taken over): the cards in the device manager carry the identity of the Roku as
// their id — not its position in the list. Sealed in the register — a change goes through the Werkbank.
import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/i18n", () => ({
  t: (key: string, ...args: unknown[]) => (args.length > 0 ? `${key}(${args.join(",")})` : key),
  tName: (key: string) => ({ en: key }),
  tDesc: (key: string) => ({ en: key }),
  tRaw: (text: string) => ({ en: text }),
}));

import { FakerokuDeviceManagement } from "../device-management";
import { deriveUuid } from "../lib/device-identity";

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

describe("K7 — card id = identity", () => {
  it("keys every card by the Roku's identity", async () => {
    const store: Store = {
      devices: [
        { name: "Wohnzimmer", port: 8060, type: "player", uuid: "0123456789abcdef0123456789abcdef", objectId: "Kino" },
        { name: "Kueche", port: 8061, type: "tv" },
      ],
    };
    const cards: { id: string; name: string }[] = [];
    await managerOver(store).loadDevices({ addDevice: card => cards.push(card) });
    expect(cards.map(card => card.id)).toEqual(["0123456789abcdef0123456789abcdef", deriveUuid("Kueche")]);
  });
});
