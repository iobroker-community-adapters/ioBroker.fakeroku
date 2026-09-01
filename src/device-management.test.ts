// t() returns something identifiable instead of a translation object, so the
// tests assert on the message CHOICE, not on wording; keys with arguments keep
// the arguments visible.
vi.mock("./lib/i18n", () => ({ t: (key: string, ...args: unknown[]) => (args.length ? { key, args } : key) }));

import { FakerokuDeviceManagement, buildDeviceForm, cleanDevice, findClash, nextFreePort } from "./device-management";
import { deriveUuid } from "./lib/device-identity";

describe("nextFreePort", () => {
  it("returns the real-Roku default when nothing is taken", () => {
    expect(nextFreePort([])).toBe(8060);
  });

  it("skips a run of taken ports", () => {
    expect(nextFreePort([8060, 8061, 8062])).toBe(8063);
  });

  it("returns 8060 when only a higher port is taken", () => {
    expect(nextFreePort([9000])).toBe(8060);
  });
});

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
});

describe("findClash", () => {
  const devices = [
    { name: "Living room", port: 8060, type: "player" as const },
    { name: "Kitchen", port: 8061, type: "tv" as const },
  ];

  it("flags a duplicate name case-insensitively", () => {
    expect(findClash(devices, { name: "living ROOM", port: 9000 }, -1)).toBe("deviceNameInUse");
  });

  it("flags a duplicate port", () => {
    expect(findClash(devices, { name: "New", port: 8061 }, -1)).toBe("devicePortInUse");
  });

  it("returns null when both name and port are free", () => {
    expect(findClash(devices, { name: "New", port: 9000 }, -1)).toBeNull();
  });

  it("excludes the edited device so its own name+port do not clash with itself", () => {
    expect(findClash(devices, { name: "Living room", port: 8060 }, 0)).toBeNull();
  });

  it("rejects a name that maps to the reserved 'info' object id", () => {
    expect(findClash(devices, { name: "info", port: 9000 }, -1)).toBe("deviceNameInvalid");
  });

  it("rejects a different name that sanitizes to the same id as another device", () => {
    // "Living room" and "Living*room" both sanitize to "Living_room" — distinct
    // names, same object tree. The plain-name check misses it; the id check catches it.
    expect(findClash(devices, { name: "Living*room", port: 9000 }, -1)).toBe("deviceNameInvalid");
  });
});

// ---------------------------------------------------------------------------
// The device-manager backend itself. Everything above is pure; the class owns
// the read/modify/write cycle on `native.devices` — the only place a user's
// device list can be silently lost, so each rule gets its own test.
// ---------------------------------------------------------------------------

/** An in-memory `system.adapter.fakeroku.0` config object as the manager sees it. */
function mockAdapter(devices: unknown = []): any {
  let stored: unknown = devices;
  return {
    namespace: "fakeroku.0",
    on: vi.fn(),
    getForeignObjectAsync: vi.fn(async (id: string) =>
      id === "system.adapter.fakeroku.0" ? { native: { devices: stored } } : null,
    ),
    extendForeignObjectAsync: vi.fn(async (_id: string, patch: { native: { devices: unknown } }) => {
      stored = patch.native.devices;
    }),
    _stored: () => stored as RokuDeviceConfig[],
  };
}

/**
 * A mock ActionContext with configurable form / confirmation answers. The
 * parameters are declared (not just ignored) so the tests can assert on the
 * schema and the pre-filled data the manager passes in.
 */
function mockContext(opts: { form?: unknown; confirm?: boolean } = {}) {
  return {
    showForm: vi.fn(async (_schema: unknown, _options: unknown) => opts.form),
    showConfirmation: vi.fn(async (_text: unknown) => opts.confirm ?? true),
    showMessage: vi.fn(async (_text: unknown) => undefined),
  };
}

type MockCtx = ReturnType<typeof mockContext>;
type RokuDeviceConfig = { name: string; port: number; type: "player" | "tv"; uuid?: string };

/** Typed access to the private manager methods under test (mirrors main.test.ts). */
interface DmInternals {
  readDevices(): Promise<RokuDeviceConfig[]>;
  loadDevices(ctx: { addDevice: (info: unknown) => void }): Promise<void>;
  getInstanceInfo(): { apiVersion: string; identifierLabel: unknown; actions: DmAction[] };
  addDevice(ctx: MockCtx): Promise<{ refresh: boolean }>;
  editDevice(index: number, ctx: MockCtx): Promise<{ refresh: "devices" }>;
  deleteDevice(index: number, ctx: MockCtx): Promise<{ refresh: "devices" }>;
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

  function make(devices: unknown = []): DmInternals {
    adapter = mockAdapter(devices);
    dm = new FakerokuDeviceManagement(adapter);
    return internalOf(dm);
  }

  /** Collect the cards loadDevices() pushes into the manager view. */
  async function cards(devices: unknown): Promise<Card[]> {
    const i = make(devices);
    const out: Card[] = [];
    await i.loadDevices({ addDevice: (c: unknown) => out.push(c as Card) });
    return out;
  }

  const living = { name: "Living room", port: 8060, type: "player" as const, uuid: "keep-me" };
  const kitchen = { name: "Kitchen", port: 8061, type: "tv" as const, uuid: "kitchen-uuid" };

  it("reads the list from the instance's OWN config object", async () => {
    const i = make([living]);
    await expect(i.readDevices()).resolves.toEqual([living]);
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
    // numeric name, and with it every add/edit dialog failed.
    const i = make([{ name: 42, port: "abc" }, null, { name: "Ok", port: 8061, type: "tv", uuid: "u1" }]);
    await expect(i.readDevices()).resolves.toEqual([
      { name: "", port: 8060, type: "player" },
      { name: "Ok", port: 8061, type: "tv", uuid: "u1" },
    ]);
    const ctx = mockContext({ form: { name: "New", port: 8070, type: "player" } });
    await expect(i.addDevice(ctx)).resolves.toEqual({ refresh: true });
    expect(adapter._stored()).toHaveLength(3);
  });

  it("shows one card per device, keyed by list position", async () => {
    const out = await cards([living, kitchen]);
    expect(out.map(c => c.id)).toEqual(["0", "1"]);
    expect(out.map(c => c.name)).toEqual(["Living room", "Kitchen"]);
  });

  it("labels the card by device type and shows the port as the identifier", async () => {
    const out = await cards([living, kitchen]);
    expect(out[0].model).toBe("Player");
    expect(out[1].model).toBe("TV");
    expect(out[0].identifier).toBe("8060");
    expect(out[1].identifier).toBe("8061");
  });

  it("falls back to a numbered name and the default port on an incomplete entry", async () => {
    const out = await cards([{ name: "", port: 0, type: "player" }]);
    // An empty card title is unclickable in the manager, and "0" as the port line
    // would tell the user the wrong thing — the adapter binds 8060 in that case.
    expect(out[0].name).toBe("Roku 1");
    expect(out[0].identifier).toBe("8060");
  });

  it("routes each card's edit/delete action to THAT card's index", async () => {
    const out = await cards([living, kitchen]);
    const del = out[1].actions.find(a => a.id === "delete")!;
    await del.handler("1", mockContext({ confirm: true }));
    // Deleting card 1 must remove Kitchen — an index mix-up here silently deletes
    // the wrong Roku, and the card ids are strings.
    expect(adapter._stored()).toEqual([living]);
  });

  it("routes a card's edit action to THAT card's index", async () => {
    const out = await cards([living, kitchen]);
    const edit = out[1].actions.find(a => a.id === "edit")!;
    await edit.handler("1", mockContext({ form: { name: "Kueche", port: 8061, type: "tv" } }));
    expect(adapter._stored()).toEqual([living, { name: "Kueche", port: 8061, type: "tv", uuid: "kitchen-uuid" }]);
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

  describe("add", () => {
    it("pre-selects a free port and appends the device with a derived uuid", async () => {
      const i = make([living]);
      const ctx = mockContext({ form: { name: "  Bedroom  ", port: 8070, type: "tv" } });
      await expect(i.addDevice(ctx)).resolves.toEqual({ refresh: true });
      expect(ctx.showForm.mock.calls[0][1]).toMatchObject({ data: { type: "player", port: 8061 } });
      expect(adapter._stored()).toEqual([
        living,
        { name: "Bedroom", port: 8070, type: "tv", uuid: deriveUuid("Bedroom") },
      ]);
    });

    it("passes the names and ports already in use into the form validator", async () => {
      const i = make([living, kitchen]);
      const ctx = mockContext({ form: undefined });
      await i.addDevice(ctx);
      const schema = ctx.showForm.mock.calls[0][0] as unknown as FormSchema;
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
      await expect(i.editDevice(0, ctx)).resolves.toEqual({ refresh: "devices" });
      // A new uuid means a new USN — the Harmony/Sofabaton drops the pairing and
      // the user has to re-add the device after a simple rename.
      expect(adapter._stored()).toEqual([{ name: "Lounge", port: 8060, type: "player", uuid: "keep-me" }]);
    });

    it("derives a uuid for a device stored without one", async () => {
      const i = make([{ name: "Old", port: 8060, type: "player" }]);
      await i.editDevice(0, mockContext({ form: { name: "Old", port: 8060, type: "player" } }));
      expect(adapter._stored()[0].uuid).toBe(deriveUuid("Old"));
    });

    it("pre-fills the form with the current device", async () => {
      const i = make([living, kitchen]);
      const ctx = mockContext({ form: undefined });
      await i.editDevice(1, ctx);
      expect(ctx.showForm.mock.calls[0][1]).toMatchObject({ data: kitchen });
    });

    it("leaves the edited device out of the dialog's in-use lists", async () => {
      const i = make([living, kitchen]);
      const ctx = mockContext({ form: undefined });
      await i.editDevice(1, ctx);
      const schema = ctx.showForm.mock.calls[0][0] as unknown as FormSchema;
      // Otherwise opening a device and pressing OK without changing anything greys
      // the button out: it clashes with itself and the user cannot edit at all.
      expect(schema.items.name.validator).not.toContain('"kitchen"');
      expect(schema.items.name.validator).toContain('"living room"');
      expect(schema.items.port.validator).not.toContain("8061");
      expect(schema.items.port.validator).toContain("8060");
    });

    it("does not clash a device with its own name and port", async () => {
      const i = make([living, kitchen]);
      const ctx = mockContext({ form: { name: "Kitchen", port: 8061, type: "tv" } });
      await i.editDevice(1, ctx);
      expect(ctx.showMessage).not.toHaveBeenCalled();
      expect(adapter._stored()).toHaveLength(2);
    });

    it("still refuses to move a device onto ANOTHER device's port", async () => {
      const i = make([living, kitchen]);
      const ctx = mockContext({ form: { name: "Kitchen", port: 8060, type: "tv" } });
      await i.editDevice(1, ctx);
      expect(ctx.showMessage).toHaveBeenCalledWith("devicePortInUse");
      expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
    });

    it("does nothing for a card index that no longer exists", async () => {
      const i = make([living]);
      const ctx = mockContext({ form: { name: "Ghost", port: 9000, type: "player" } });
      await expect(i.editDevice(5, ctx)).resolves.toEqual({ refresh: "devices" });
      // A stale manager view must not open a form that would then append a device.
      expect(ctx.showForm).not.toHaveBeenCalled();
      expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
    });
  });

  describe("delete", () => {
    it("removes exactly the selected device after confirmation", async () => {
      const i = make([living, kitchen]);
      const ctx = mockContext({ confirm: true });
      await expect(i.deleteDevice(0, ctx)).resolves.toEqual({ refresh: "devices" });
      expect(ctx.showConfirmation).toHaveBeenCalledWith({ key: "dmDeleteConfirm", args: ["Living room"] });
      expect(adapter._stored()).toEqual([kitchen]);
    });

    it("keeps the device when the user declines", async () => {
      const i = make([living, kitchen]);
      await i.deleteDevice(0, mockContext({ confirm: false }));
      expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
      expect(adapter._stored()).toEqual([living, kitchen]);
    });

    it("does not even ask for a card index that no longer exists", async () => {
      const i = make([living]);
      const ctx = mockContext({ confirm: true });
      await expect(i.deleteDevice(5, ctx)).resolves.toEqual({ refresh: "devices" });
      // Without the guard, splice(5,1) is a no-op but the write still fires and the
      // user has confirmed deleting a device that was never named.
      expect(ctx.showConfirmation).not.toHaveBeenCalled();
      expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
    });
  });
});

/** The subset of the generated jsonConfig panel the tests inspect. */
interface FormSchema {
  type: string;
  items: Record<string, { type?: string; validator?: string; validatorNoSaveOnError?: boolean; default?: unknown }>;
}

describe("buildDeviceForm", () => {
  it("offers name, port and type plus the two hints", () => {
    const form = buildDeviceForm([], []) as unknown as FormSchema;
    expect(form.type).toBe("panel");
    expect(Object.keys(form.items)).toEqual(["name", "port", "type", "_portHint", "_typeHint"]);
    expect(form.items.type.default).toBe("player");
  });

  it("blocks saving on a clash instead of only colouring the field", () => {
    const form = buildDeviceForm(["A"], [8060]) as unknown as FormSchema;
    // Without validatorNoSaveOnError the dialog shows the error AND still saves —
    // the duplicate then only fails in the backend check, after the round-trip.
    expect(form.items.name.validatorNoSaveOnError).toBe(true);
    expect(form.items.port.validatorNoSaveOnError).toBe(true);
  });

  it("compares names trimmed and lower-cased, so a re-typed name still clashes", () => {
    const form = buildDeviceForm(["  Living Room "], [8060]) as unknown as FormSchema;
    expect(form.items.name.validator).toContain('["living room"]');
  });

  it("keeps the validator valid code when a name carries quotes or backslashes", () => {
    const form = buildDeviceForm(['Say "hi"', "back\\slash"], []) as unknown as FormSchema;
    const literal = form.items.name.validator!.match(/^!(\[.*\])\.includes\(/)?.[1];
    expect(literal).toBeDefined();
    // The admin evaluates this string as JavaScript. An unescaped quote ends the array
    // early and every duplicate-name check in the dialog silently stops working.
    expect(JSON.parse(literal!)).toEqual(['say "hi"', "back\\slash"]);
  });

  it("compares ports as numbers, so a typed '8060' is caught", () => {
    const form = buildDeviceForm([], [8060]) as unknown as FormSchema;
    expect(form.items.port.validator).toBe("![8060].includes(Number(data.port))");
  });
});
