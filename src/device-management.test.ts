import { runInNewContext } from "node:vm";
import type { Mock } from "vitest";
// t() returns something identifiable instead of a translation object, so the
// tests assert on the message CHOICE, not on wording; keys with arguments keep
// the arguments visible.
vi.mock("./lib/i18n", () => ({ t: (key: string, ...args: unknown[]) => (args.length ? { key, args } : key) }));

import { FakerokuDeviceManagement, buildDeviceForm, cleanDevice } from "./device-management";
import { deviceObjectId, toDeviceRows } from "./lib/device-config";
import { deriveUuid, resolveDeviceUuid } from "./lib/device-identity";

/** A random identity as the manager hands one to a new device: 32 lower-case hex digits. */
const RANDOM_ID = /^[0-9a-f]{32}$/;

describe("cleanDevice", () => {
  it("trims the name, coerces the port, defaults an unknown type to player", () => {
    expect(cleanDevice({ name: "  Living room  ", port: "8060", type: "x" })).toEqual({
      name: "Living room",
      port: 8060,
      type: "player",
    });
  });

  it("keeps a tv type and falls back to the default port on garbage", () => {
    expect(cleanDevice({ name: "TV", port: "abc", type: "tv" })).toEqual({ name: "TV", port: 8060, type: "tv" });
  });

  it("turns a name that is not a string into an empty one, so the caller can refuse it", () => {
    // The form hands back whatever the admin sent; the callers treat "" as a cancel.
    expect(cleanDevice({ name: 42, port: 8060 }).name).toBe("");
    expect(cleanDevice({ port: 8060 }).name).toBe("");
  });

  it("refuses a port a server could not bind, instead of storing it", () => {
    expect(cleanDevice({ name: "TV", port: -5, type: "tv" }).port).toBe(8060);
    expect(cleanDevice({ name: "TV", port: 70000, type: "tv" }).port).toBe(8060);
  });
});

// ---------------------------------------------------------------------------
// The device-manager backend itself. Everything above is pure; the class owns
// the read/modify/write cycle on `native.devices` — the only place a user's
// device list can be silently lost, so each rule gets its own test.
// ---------------------------------------------------------------------------

/**
 * An in-memory `system.adapter.fakeroku.0` config object as the manager sees it.
 *
 * `extendForeignObjectAsync` REPLACES native.devices here, and that is faithful, not a
 * shortcut: js-controller clears the stored array before merging for exactly four key
 * names, and `native.devices` is one of them (adapter.ts `_extendForeignObject`). Under any
 * other name the merge would be element-wise and a shorter list would leave the tail in
 * place — see the "writes the list under the key js-controller replaces" test below.
 *
 * @param devices Device list stored in native.devices
 * @param objects The adapter's object tree, keyed relative to the namespace
 */
function mockAdapter(devices: unknown = [], objects: Record<string, { type: string }> = {}): any {
  let stored: unknown = devices;
  return {
    namespace: "fakeroku.0",
    on: vi.fn(),
    // A copy, as the controller answers; the manager resolves object ids and legacy types against it.
    getAdapterObjectsAsync: vi.fn(() =>
      Promise.resolve(
        Object.fromEntries(Object.entries(objects).map(([id, o]) => [`fakeroku.0.${id}`, structuredClone(o)])),
      ),
    ),
    getForeignObjectAsync: vi.fn((id: string) =>
      // A copy, as the controller answers — only writeDevices reaches `stored`.
      Promise.resolve(id === "system.adapter.fakeroku.0" ? { native: { devices: structuredClone(stored) } } : null),
    ),
    extendForeignObjectAsync: vi.fn((_id: string, patch: { native: { devices: unknown } }) => {
      stored = patch.native.devices;
      return Promise.resolve();
    }),
    _stored: () => stored as RokuDeviceConfig[],
  };
}

/**
 * A mock ActionContext with configurable form / confirmation answers. The
 * parameters are declared (not just ignored) so the tests can assert on the
 * schema and the pre-filled data the manager passes in.
 *
 * @param opts Canned answers for the dialogs
 * @param opts.form What showForm resolves with
 * @param opts.confirm What showConfirmation resolves with (default true)
 */
function mockContext(opts: { form?: unknown; confirm?: boolean } = {}): {
  showForm: Mock;
  showConfirmation: Mock;
  showMessage: Mock;
} {
  return {
    showForm: vi.fn((_schema: unknown, _options: unknown) => Promise.resolve(opts.form)),
    showConfirmation: vi.fn((_text: unknown) => Promise.resolve(opts.confirm ?? true)),
    showMessage: vi.fn((_text: unknown) => Promise.resolve(undefined)),
  };
}

type MockCtx = ReturnType<typeof mockContext>;
type RokuDeviceConfig = { name: string; port: number; type: "player" | "tv"; uuid?: string; objectId?: string };

/** Typed access to the private manager methods under test (mirrors main.test.ts). */
interface DmInternals {
  readDevices(): Promise<{ storedName: string; name: string; port: number; type: string; identity: string }[]>;
  loadDevices(ctx: { addDevice: (info: unknown) => void }): Promise<void>;
  getInstanceInfo(): { apiVersion: string; identifierLabel: unknown; actions: DmAction[] };
  addDevice(ctx: MockCtx): Promise<{ refresh: boolean }>;
  editDevice(cardId: string, ctx: MockCtx): Promise<{ refresh: "devices" }>;
  deleteDevice(cardId: string, ctx: MockCtx): Promise<{ refresh: "devices" }>;
}
interface DmAction {
  id: string;
  icon: string;
  description: unknown;
  handler: (...args: any[]) => Promise<unknown>;
}
interface Card {
  id: string;
  name: string;
  identifier: string;
  model: string;
  actions: DmAction[];
}
const internalOf = (dm: FakerokuDeviceManagement): DmInternals => dm as unknown as DmInternals;

describe("FakerokuDeviceManagement", () => {
  let adapter: ReturnType<typeof mockAdapter>;
  let dm: FakerokuDeviceManagement;

  function make(devices: unknown = [], objects: Record<string, { type: string }> = {}): DmInternals {
    adapter = mockAdapter(devices, objects);
    dm = new FakerokuDeviceManagement(adapter);
    return internalOf(dm);
  }

  /**
   * Collect the cards loadDevices() pushes into the manager view.
   *
   * @param devices Device list the manager loads the cards from
   */
  async function cards(devices: unknown): Promise<Card[]> {
    const i = make(devices);
    const out: Card[] = [];
    await i.loadDevices({ addDevice: (c: unknown) => out.push(c as Card) });
    return out;
  }

  const living = { name: "Living room", port: 8060, type: "player" as const, uuid: "keep-me" };
  const kitchen = { name: "Kitchen", port: 8061, type: "tv" as const, uuid: "kitchen-uuid" };
  // How the manager writes them back: with the object id they occupy, fixed from now on.
  const livingStored = { ...living, objectId: "Living_room" };
  const kitchenStored = { ...kitchen, objectId: "Kitchen" };

  it("reads the list from the instance's OWN config object", async () => {
    const i = make([living]);
    const rows = await i.readDevices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Living room", port: 8060, type: "player", identity: "keep-me" });
    expect(adapter.getForeignObjectAsync).toHaveBeenCalledWith("system.adapter.fakeroku.0");
  });

  it("survives a native.devices that is not an array", async () => {
    // A hand-edited config (or an old instance) can leave anything here. Returning
    // it raw would make .map/.filter throw and take the whole manager view down.
    await expect(make("nonsense").readDevices()).resolves.toEqual([]);
    await expect(make(undefined).readDevices()).resolves.toEqual([]);
  });

  it("normalises hand-edited rows so the dialogs keep working", async () => {
    // Expert mode / CLI can leave anything in native.devices: a numeric name, a
    // garbage port, a null row. The clash check's .trim() used to throw on the
    // numeric name, and with it every add/edit dialog failed. A row with no usable
    // name is dropped now — the manager could not have saved it either.
    const i = make([{ name: 42, port: "abc" }, null, { name: "Ok", port: 8061, type: "tv", uuid: "u1" }]);
    const rows = await i.readDevices();
    expect(rows.map(r => r.name)).toEqual(["Ok"]);
    const ctx = mockContext({ form: { name: "New", port: 8070, type: "player" } });
    await expect(i.addDevice(ctx)).resolves.toEqual({ refresh: true });
    expect(adapter._stored()).toHaveLength(2);
  });

  it("shows one card per device, keyed by the device identity", async () => {
    const out = await cards([living, kitchen]);
    // NOT the list position: a card id has to survive a list that changed underneath
    // the view (a second admin tab), or edit/delete hits a different device.
    expect(out.map(c => c.id)).toEqual(["keep-me", "kitchen-uuid"]);
    expect(out.map(c => c.name)).toEqual(["Living room", "Kitchen"]);
  });

  it("labels the card by device type and shows the port as the identifier", async () => {
    const out = await cards([living, kitchen]);
    // Translated like the dialog, not a fixed English word.
    expect(out[0].model).toBe("deviceTypePlayer");
    expect(out[1].model).toBe("deviceTypeTv");
    expect(out[0].identifier).toBe("8060");
    expect(out[1].identifier).toBe("8061");
  });

  it("shows the trimmed name and the port the adapter really binds", async () => {
    const out = await cards([{ name: " ⏻ ", port: 0, type: "player" }]);
    // "0" as the port line would tell the user the wrong thing — the adapter binds 8060.
    expect(out[0].name).toBe("⏻");
    expect(out[0].identifier).toBe("8060");
  });

  it("shows no card at all for a row without a usable name", async () => {
    // There is no "unnamed card" case any more: such a row is dropped when the list is
    // read, so the manager never has to invent a stand-in name for it.
    expect(await cards([{ name: "   ", port: 8060, type: "player" }])).toEqual([]);
  });

  it("routes each card's delete action to THAT card's device", async () => {
    const out = await cards([living, kitchen]);
    const del = out[1].actions.find(a => a.id === "delete")!;
    await del.handler(out[1].id, mockContext({ confirm: true }));
    expect(adapter._stored()).toEqual([livingStored]);
  });

  it("routes a card's edit action to THAT card's device", async () => {
    const out = await cards([living, kitchen]);
    const edit = out[1].actions.find(a => a.id === "edit")!;
    await edit.handler(out[1].id, mockContext({ form: { name: "Kueche", port: 8061, type: "tv" } }));
    // Renamed, same identity, SAME object id — the tree, its rooms and history stay put.
    expect(adapter._stored()).toEqual([
      livingStored,
      { name: "Kueche", port: 8061, type: "tv", uuid: "kitchen-uuid", objectId: "Kitchen" },
    ]);
  });

  it("acts on the clicked device even when the list shifted under a stale view", async () => {
    // Two admin tabs: the view still shows [living, kitchen], the config already lost
    // living. With a positional card id, "delete kitchen" would have deleted whatever
    // now sits at index 1 — or nothing at all.
    const out = await cards([living, kitchen]);
    const i = make([kitchen]);
    await i.deleteDevice(out[1].id, mockContext({ confirm: true }));
    expect(adapter._stored()).toEqual([]);
  });

  it("routes the instance-level add action to addDevice", async () => {
    make([living]);
    const add = internalOf(dm).getInstanceInfo().actions[0];
    await add.handler(mockContext({ form: { name: "Bedroom", port: 8070, type: "player" } }));
    expect(adapter._stored()).toHaveLength(2);
  });

  it("offers exactly edit and delete per card", async () => {
    const out = await cards([living]);
    expect(out[0].actions.map(a => a.id)).toEqual(["edit", "delete"]);
    expect(out[0].actions.map(a => a.icon)).toEqual(["edit", "delete"]);
  });

  it("declares the v3 API and a single add action", () => {
    const info = make([]).getInstanceInfo();
    // The manager silently shows nothing for a wrong apiVersion.
    expect(info.apiVersion).toBe("v3");
    expect(info.identifierLabel).toBe("portLabel");
    expect(info.actions.map(a => a.id)).toEqual(["add"]);
  });

  it("writes the list under the key js-controller replaces instead of merging", async () => {
    // js-controller merges an extendObject payload with node.extend(true, …), which
    // merges arrays ELEMENT-WISE — a shorter list would leave the tail in place and a
    // deleted device would come back. It clears the old array first for exactly four key
    // names, `native.devices` among them. This test pins the key: renaming it (or writing
    // the list anywhere else) silently breaks every deletion.
    const i = make([living, kitchen]);
    await i.deleteDevice("kitchen-uuid", mockContext({ confirm: true }));
    const [, patch] = adapter.extendForeignObjectAsync.mock.calls[0];
    expect(Object.keys(patch)).toEqual(["native"]);
    expect(Object.keys(patch.native)).toEqual(["devices"]);
    // The FULL remaining list, not a patch of the changed positions.
    expect(patch.native.devices).toEqual([livingStored]);
  });

  describe("add", () => {
    it("pre-selects a free port and appends the device with its own identity and a fixed object id", async () => {
      const i = make([living]);
      const ctx = mockContext({ form: { name: "  Bedroom  ", port: 8070, type: "tv" } });
      await expect(i.addDevice(ctx)).resolves.toEqual({ refresh: true });
      expect(ctx.showForm.mock.calls[0][1]).toMatchObject({ data: { type: "player", port: 8061 } });
      const [first, added] = adapter._stored();
      expect(first).toEqual(livingStored);
      expect(added).toMatchObject({ name: "Bedroom", port: 8070, type: "tv", objectId: "Bedroom" });
      // Random, not derived from the name: every installation with a "Bedroom" would share it.
      expect(added.uuid).toMatch(RANDOM_ID);
      expect(added.uuid).not.toBe(deriveUuid("Bedroom"));
    });

    it("hands the dialog the rule that switches OK off", async () => {
      // dm-gui-components disables OK only through applyDisabledRule (or an unchanged form) —
      // a field validator colours the field and nothing more.
      const i = make([living]);
      const ctx = mockContext({ form: undefined });
      await i.addDevice(ctx);
      const options = ctx.showForm.mock.calls[0][1] as { applyDisabledRule: string };
      expect(evaluateRule(options.applyDisabledRule, { name: "Living room", port: 9000 })).toBe(true);
      expect(evaluateRule(options.applyDisabledRule, { name: "Bedroom", port: 8060 })).toBe(true);
      expect(evaluateRule(options.applyDisabledRule, { name: "Bedroom", port: 9000 })).toBe(false);
    });

    it("passes the names and ports already in use into the form validator", async () => {
      const i = make([living, kitchen]);
      const ctx = mockContext({ form: undefined });
      await i.addDevice(ctx);
      const schema = ctx.showForm.mock.calls[0][0] as FormSchema;
      // The greyed-out OK button is the user's only in-dialog feedback; it works
      // off these literal lists, so an empty list means every clash gets through.
      expect(schema.items.name.validator).toContain('"living room"');
      expect(schema.items.name.validator).toContain('"kitchen"');
      expect(schema.items.port.validator).toContain("8060");
      expect(schema.items.port.validator).toContain("8061");
    });

    it("writes nothing when the dialog is cancelled", async () => {
      const i = make([living]);
      const ctx = mockContext({ form: undefined });
      await i.addDevice(ctx);
      expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
      expect(adapter._stored()).toEqual([living]);
    });

    it("treats a blank name as a cancel — no device, and no error popup", async () => {
      const i = make([living]);
      const ctx = mockContext({ form: { name: "   ", port: 8070, type: "player" } });
      await i.addDevice(ctx);
      expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
      // Confirming an untouched dialog must not throw a validation error at the
      // user; without the name check the clash guard fires "deviceNameInvalid".
      expect(ctx.showMessage).not.toHaveBeenCalled();
    });

    it("ignores a non-string name from the form", async () => {
      const i = make([living]);
      const ctx = mockContext({ form: { name: 42, port: 8070, type: "player" } });
      await i.addDevice(ctx);
      expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
      expect(ctx.showMessage).not.toHaveBeenCalled();
    });

    it("refuses a clash and tells the user instead of writing it", async () => {
      const i = make([living]);
      const ctx = mockContext({ form: { name: "New", port: 8060, type: "player" } });
      await i.addDevice(ctx);
      // The form validator can be bypassed (older admin, message API) — the backend
      // check is what actually keeps two Rokus off the same port.
      expect(ctx.showMessage).toHaveBeenCalledWith("devicePortInUse");
      expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
    });
  });

  describe("edit", () => {
    it("keeps the stored uuid across a rename so the pairing survives", async () => {
      const i = make([living]);
      const ctx = mockContext({ form: { name: "Lounge", port: 8060, type: "player" } });
      await expect(i.editDevice("keep-me", ctx)).resolves.toEqual({ refresh: "devices" });
      // A new uuid means a new USN — the Harmony/Sofabaton drops the pairing and
      // the user has to re-add the device after a simple rename.
      expect(adapter._stored()).toEqual([
        { name: "Lounge", port: 8060, type: "player", uuid: "keep-me", objectId: "Living_room" },
      ]);
    });

    it("derives a uuid for a device stored without one", async () => {
      const i = make([{ name: "Old", port: 8060, type: "player" }]);
      await i.editDevice(deriveUuid("Old"), mockContext({ form: { name: "Old", port: 8060, type: "player" } }));
      expect(adapter._stored()[0].uuid).toBe(deriveUuid("Old"));
    });

    it("derives the uuid of a row without one from its OLD name, so a rename keeps the identity", async () => {
      // The manifest's default device carries no uuid, so main.ts identifies it by
      // deriveUuid(storedName). Deriving from the NEW name here would move the SSDP
      // identity on a plain rename and silently unpair the remote.
      const i = make([{ name: "Roku", port: 8060, type: "player" }]);
      await i.editDevice(deriveUuid("Roku"), mockContext({ form: { name: "Wohnzimmer", port: 8060, type: "player" } }));
      expect(adapter._stored()[0]).toEqual({
        name: "Wohnzimmer",
        port: 8060,
        type: "player",
        uuid: deriveUuid("Roku"),
        objectId: "Roku",
      });
      expect(adapter._stored()[0].uuid).not.toBe(deriveUuid("Wohnzimmer"));
    });

    it("stores exactly the identity the runtime resolves for that row", async () => {
      // Binds the two sites that must agree: both go through the same normaliser, so
      // an edit can never persist a different answer than the one being advertised.
      const stored = { name: "Roku", port: 8060, type: "player" as const };
      const i = make([stored]);
      await i.editDevice(
        resolveDeviceUuid(stored),
        mockContext({ form: { name: "Schlafzimmer", port: 8060, type: "player" } }),
      );
      expect(adapter._stored()[0].uuid).toBe(resolveDeviceUuid(stored));
    });

    it("keeps the identity of an UNTRIMMED stored name — saving must not re-pair the remote", async () => {
      // The measured defect: the manager normalised the row before resolving its
      // identity, so for a name stored with surrounding whitespace it saved
      // deriveUuid("Roku") while the runtime was advertising deriveUuid(" Roku ").
      // Opening the card and pressing save — changing nothing — unpaired the remote.
      const stored = { name: " Roku ", port: 8060, type: "player" as const };
      const i = make([stored]);
      const runtimeIdentity = resolveDeviceUuid(stored);
      await i.editDevice(runtimeIdentity, mockContext({ form: { name: "Roku", port: 8060, type: "player" } }));
      expect(adapter._stored()[0].uuid).toBe(runtimeIdentity);
      expect(adapter._stored()[0].uuid).not.toBe(deriveUuid("Roku"));
    });

    it("leaves the name of a device the user did not touch exactly as it was stored", async () => {
      // Trimming someone else's row would move ITS object id on the next start — a tree
      // wandering, and every script pointing into it breaking, because a different card
      // was saved. Only the edited row takes the trimmed name.
      const untouched = { name: " Bedroom ", port: 8061, type: "player" as const };
      const i = make([living, untouched]);
      await i.editDevice("keep-me", mockContext({ form: { name: "Lounge", port: 8060, type: "player" } }));
      expect(adapter._stored()[1]).toEqual({
        name: " Bedroom ",
        port: 8061,
        type: "player",
        uuid: deriveUuid(" Bedroom "),
        objectId: "_Bedroom_",
      });
    });

    it("heals an unusable stored device id instead of writing it back unchanged", async () => {
      // A hand-edited id with characters that cannot go into an SSDP header was
      // rejected by the runtime on every start (a warning per start) but survived
      // every edit. The edit now replaces it with the derived one.
      const i = make([{ name: "Roku", port: 8060, type: "player", uuid: "not a/valid id" }]);
      await i.editDevice(deriveUuid("Roku"), mockContext({ form: { name: "Roku", port: 8060, type: "player" } }));
      expect(adapter._stored()[0].uuid).toBe(deriveUuid("Roku"));
    });

    it("pre-fills the form with the current device", async () => {
      const i = make([living, kitchen]);
      const ctx = mockContext({ form: undefined });
      await i.editDevice("kitchen-uuid", ctx);
      expect(ctx.showForm.mock.calls[0][1]).toMatchObject({ data: { name: "Kitchen", port: 8061, type: "tv" } });
    });

    it("keeps the tree of a device the OLD adapter created, even when its name has an umlaut", async () => {
      // The pre-0.6.0 adapter built "Küche" as the object id; the rebuild would build "K_che" —
      // and the orphan sweep used to delete the old tree with its values, rooms and history.
      const i = make([{ name: "Küche", port: 9093, uuid: "legacy-uuid" }], { Küche: { type: "device" } });
      await i.editDevice("legacy-uuid", mockContext({ form: { name: "Küche", port: 9093, type: "player" } }));
      expect(adapter._stored()[0].objectId).toBe("Küche");
    });

    it("keeps a TV's keys for a row from before 0.7.0 that stored no type", async () => {
      // The old adapter created every key the remote pressed, TV keys included; read as a player
      // the row would have its VolumeUp & co. swept away.
      const i = make([{ name: "TV", port: 9093, uuid: "legacy-tv" }], {
        TV: { type: "device" },
        "TV.keys.VolumeUp": { type: "state" },
      });
      await i.editDevice("legacy-tv", mockContext({ form: { name: "TV", port: 9093, type: "tv" } }));
      const rows = await i.readDevices();
      expect(rows[0].type).toBe("tv");
    });

    it("the edit form has no object-id rule — a renamed device keeps its tree", async () => {
      const i = make([living, kitchen]);
      const ctx = mockContext({ form: undefined });
      await i.editDevice("kitchen-uuid", ctx);
      const schema = ctx.showForm.mock.calls[0][0] as FormSchema;
      expect(schema.items.name.validator).not.toContain("Living_room");
      // A name whose id another device occupies is fine for a rename: the id does not move.
      expect(evaluateValidator(schema.items.name.validator!, { name: "Living*room" })).toBe(true);
    });

    it("leaves the edited device out of the dialog's in-use lists", async () => {
      const i = make([living, kitchen]);
      const ctx = mockContext({ form: undefined });
      await i.editDevice("kitchen-uuid", ctx);
      const schema = ctx.showForm.mock.calls[0][0] as FormSchema;
      // Otherwise opening a device and pressing OK without changing anything greys
      // the button out: it clashes with itself and the user cannot edit at all.
      expect(schema.items.name.validator).not.toContain('"kitchen"');
      expect(schema.items.name.validator).toContain('"living room"');
      expect(schema.items.port.validator).not.toContain("8061");
      expect(schema.items.port.validator).toContain("8060");
    });

    it("feeds the dialog the object ids the RUNTIME will use, not ids of display names", async () => {
      // The one place the dialog and the start have to agree. A row stored as " Roku "
      // occupies "_Roku_" in the object tree; sanitising what the list DISPLAYS yields
      // "Roku" and lets a device literally called "_Roku_" through. The start then skips
      // it as a duplicate id and info.connection stays false with nothing pointing back
      // at the dialog that accepted it.
      const spaced = { name: " Roku ", port: 8062, type: "player" as const, uuid: "spaced-uuid" };
      const i = make([living, spaced]);
      const ctx = mockContext({ form: undefined });
      await i.addDevice(ctx);
      const schema = ctx.showForm.mock.calls[0][0] as FormSchema;
      expect(schema.items.name.validator).toContain('"_Roku_"');
      expect(schema.items.name.validator).not.toContain('"Roku"');
    });

    it("does not clash a device with its own name and port", async () => {
      const i = make([living, kitchen]);
      const ctx = mockContext({ form: { name: "Kitchen", port: 8061, type: "tv" } });
      await i.editDevice("kitchen-uuid", ctx);
      expect(ctx.showMessage).not.toHaveBeenCalled();
      expect(adapter._stored()).toHaveLength(2);
    });

    it("still refuses to move a device onto ANOTHER device's port", async () => {
      const i = make([living, kitchen]);
      const ctx = mockContext({ form: { name: "Kitchen", port: 8060, type: "tv" } });
      await i.editDevice("kitchen-uuid", ctx);
      expect(ctx.showMessage).toHaveBeenCalledWith("devicePortInUse");
      expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
    });

    it("does nothing for a card that no longer exists", async () => {
      const i = make([living]);
      const ctx = mockContext({ form: { name: "Ghost", port: 9000, type: "player" } });
      await expect(i.editDevice("gone", ctx)).resolves.toEqual({ refresh: "devices" });
      // A stale manager view must not open a form that would then append a device.
      expect(ctx.showForm).not.toHaveBeenCalled();
      expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
    });
  });

  describe("delete", () => {
    it("removes exactly the selected device after confirmation", async () => {
      const i = make([living, kitchen]);
      const ctx = mockContext({ confirm: true });
      await expect(i.deleteDevice("keep-me", ctx)).resolves.toEqual({ refresh: "devices" });
      expect(ctx.showConfirmation).toHaveBeenCalledWith({ key: "dmDeleteConfirm", args: ["Living room"] });
      expect(adapter._stored()).toEqual([kitchenStored]);
    });

    it("keeps the device when the user declines", async () => {
      const i = make([living, kitchen]);
      await i.deleteDevice("keep-me", mockContext({ confirm: false }));
      expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
      expect(adapter._stored()).toEqual([living, kitchen]);
    });

    it("does not even ask for a card that no longer exists", async () => {
      const i = make([living]);
      const ctx = mockContext({ confirm: true });
      await expect(i.deleteDevice("gone", ctx)).resolves.toEqual({ refresh: "devices" });
      // Without the guard, splice(-1,1) removes the LAST device — the user confirms
      // deleting one Roku and loses another.
      expect(ctx.showConfirmation).not.toHaveBeenCalled();
      expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
    });

    it("writes the empty list when the last device goes, so the tree gets swept", async () => {
      const i = make([living]);
      await i.deleteDevice("keep-me", mockContext({ confirm: true }));
      expect(adapter._stored()).toEqual([]);
    });
  });
});

/** The subset of the generated jsonConfig panel the tests inspect. */
interface FormSchema {
  type: string;
  items: Record<
    string,
    { type?: string; validator?: string; validatorNoSaveOnError?: boolean; default?: unknown; hidden?: unknown }
  >;
}

/**
 * Run the OK rule the way dm-gui-components does (`Function('data', 'return ' + rule)`).
 *
 * @param rule the applyDisabledRule expression
 * @param data the form values
 * @returns true = OK is disabled
 */
function evaluateRule(rule: string, data: Record<string, unknown>): boolean {
  return runInNewContext(`(${rule})`, { data }) as boolean;
}

/**
 * Run a validator expression the way the admin does: as JavaScript over the form `data`.
 *
 * The expression is a STRING in the shipped panel — no test executes it by looking at it,
 * which is exactly how a wrong decision stays green (a text-pattern test passes while the
 * dialog lets the clash through). An isolated context is the honest stand-in for the
 * admin's evaluation.
 *
 * @param validator the validator expression from the schema
 * @param data the form values to evaluate it against
 * @returns what the admin would get: true = valid, false = show the error and block saving
 */
function evaluateValidator(validator: string, data: Record<string, unknown>): boolean {
  return runInNewContext(`(${validator})`, { data }) as boolean;
}

describe("buildDeviceForm", () => {
  it("offers name, port and type, the two reasons and the two hints", () => {
    const form = buildDeviceForm([], [], []).schema as unknown as FormSchema;
    expect(form.type).toBe("panel");
    expect(Object.keys(form.items)).toEqual([
      "name",
      "port",
      "type",
      "_nameRejected",
      "_portRejected",
      "_portHint",
      "_typeHint",
    ]);
    expect(form.items.type.default).toBe("player");
  });

  it("shows the reason for a refused name or port as text, and only then", () => {
    // The text fields show no validator message of their own — the red field alone does not
    // say why.
    const form = buildDeviceForm(["A"], [8060], ["A"]).schema as unknown as FormSchema;
    const shown = (item: string, data: Record<string, unknown>): boolean =>
      !(runInNewContext(`(${form.items[item].hidden as string})`, { data }) as boolean);
    expect(shown("_nameRejected", { name: "a", port: 9000 })).toBe(true);
    expect(shown("_nameRejected", { name: "B", port: 9000 })).toBe(false);
    // An empty field is not an error yet — nothing typed, nothing to explain.
    expect(shown("_nameRejected", { name: "", port: 9000 })).toBe(false);
    expect(shown("_portRejected", { name: "B", port: 8060 })).toBe(true);
    expect(shown("_portRejected", { name: "B", port: 9000 })).toBe(false);
  });

  it("switches OK off for an empty name as well", () => {
    const { applyDisabledRule } = buildDeviceForm([], [], []);
    expect(evaluateRule(applyDisabledRule, { name: "", port: 9000 })).toBe(true);
    expect(evaluateRule(applyDisabledRule, { name: "X", port: 9000 })).toBe(false);
  });

  it("marks a clash on the field as well as switching OK off", () => {
    const form = buildDeviceForm(["A"], [8060], ["A"]).schema as unknown as FormSchema;
    // Without validatorNoSaveOnError the dialog shows the error AND still saves —
    // the duplicate then only fails in the backend check, after the round-trip.
    expect(form.items.name.validatorNoSaveOnError).toBe(true);
    expect(form.items.port.validatorNoSaveOnError).toBe(true);
  });

  it("compares names trimmed and lower-cased, so a re-typed name still clashes", () => {
    const form = buildDeviceForm(["  Living Room "], [8060], []).schema as unknown as FormSchema;
    expect(form.items.name.validator).toContain('["living room"]');
  });

  it("keeps the validator valid code when a name carries quotes or backslashes", () => {
    const form = buildDeviceForm(['Say "hi"', "back\\slash"], [], []).schema as unknown as FormSchema;
    const literal = form.items.name.validator!.match(/\[[^\]]*"say \\"hi\\""[^\]]*\]/)?.[0];
    expect(literal).toBeDefined();
    // The admin evaluates this string as JavaScript. An unescaped quote ends the array
    // early and every duplicate-name check in the dialog silently stops working.
    expect(JSON.parse(literal!)).toEqual(['say "hi"', "back\\slash"]);
  });

  describe("the name validator, evaluated the way the admin evaluates it", () => {
    // Fed the way the manager feeds it: displayed names from the rows, object ids from
    // deviceObjectId. The two are not the same function of the same string — one row here
    // is stored with edge spaces, exactly the case that used to slip through.
    const rows = toDeviceRows([
      { name: "Living room", port: 8060, type: "player" },
      { name: "Kitchen", port: 8061, type: "player" },
      { name: " Roku ", port: 8062, type: "player" },
    ])!;
    const form = buildDeviceForm(
      rows.map(r => r.name),
      rows.map(r => r.port),
      rows.map(deviceObjectId),
    ).schema as unknown as FormSchema;
    const check = (name: unknown): boolean => evaluateValidator(form.items.name.validator!, { name });

    it("accepts a free name", () => {
      expect(check("Bedroom")).toBe(true);
    });

    it("refuses a name already in use, however it is typed", () => {
      expect(check("living room")).toBe(false);
      expect(check("  LIVING ROOM  ")).toBe(false);
      expect(check("Kitchen")).toBe(false);
    });

    it("refuses the reserved name that would overwrite the adapter's own status channel", () => {
      expect(check("info")).toBe(false);
    });

    it("refuses a different name that lands on another device's object id", () => {
      // "Living*room" and "Living room" both sanitize to "Living_room": two cards, one tree.
      // The id comparison is case-SENSITIVE on purpose — ioBroker object ids are, and a
      // name differing only in case is already caught by the name rule above.
      expect(check("Living*room")).toBe(false);
      expect(check("Living*Room")).toBe(true);
    });

    it("refuses the id of a row STORED with edge spaces, which its display name hides", () => {
      // The row saved as " Roku " is listed as "Roku" but owns "_Roku_" in the object tree.
      // Judging the displayed name let a device literally called "_Roku_" through here, and
      // the start then skipped it as a duplicate id — the instance stayed red with no
      // message pointing at the dialog that accepted it.
      expect(deviceObjectId(rows[2])).toBe("_Roku_");
      expect(check("_Roku_")).toBe(false);
      // Its trimmed display name is refused too, but by the older name rule — the two
      // questions are separate, and only the id one reaches the tree.
      expect(check("Roku")).toBe(false);
      expect(check("Roku2")).toBe(true);
    });

    it("refuses a name that sanitizes to nothing at all", () => {
      expect(check("")).toBe(false);
      expect(check("   ")).toBe(false);
      expect(check(undefined)).toBe(false);
    });
  });

  it("compares ports as numbers, so a typed '8060' is caught", () => {
    const form = buildDeviceForm([], [8060], []).schema as unknown as FormSchema;
    expect(form.items.port.validator).toBe("(![8060].includes(Number(data.port)))");
    expect(evaluateValidator(form.items.port.validator!, { port: "8060" })).toBe(false);
    expect(evaluateValidator(form.items.port.validator!, { port: 8061 })).toBe(true);
  });
});
