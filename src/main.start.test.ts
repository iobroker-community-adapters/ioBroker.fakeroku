import { vi } from "vitest";
import type * as OsModule from "node:os";

/**
 * Orchestration tests of the adapter — The start: the object tree per device, identities, names, reserved ids, the key reset, the orphan sweep and the legacy repairs inside objects.
 * Shared doubles and harness: `test/helpers/`.
 */
vi.mock("@iobroker/adapter-core", () => vi.importActual("../test/helpers/adapter-core-double"));
vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof OsModule>();
  const { osMock } = await vi.importActual<{ osMock: { interfaces: Record<string, unknown[]> | null } }>(
    "../test/helpers/os-double",
  );
  const networkInterfaces = (): unknown => osMock.interfaces ?? actual.networkInterfaces();
  return { ...actual, default: { ...actual, networkInterfaces }, networkInterfaces };
});

import { I18n } from "@iobroker/adapter-core";
import { join } from "node:path";
import { deriveUuid } from "./lib/device-identity";
import { setup, resetHarness, noAddressYet, twoPlayers, fakeEcp } from "../test/helpers/fakeroku-harness";

afterEach(resetHarness);

describe("Fakeroku onReady — device wiring", () => {
  it("creates the full object tree and starts one ECP server per device", async () => {
    const ctx = setup({
      devices: [
        { name: "Wohnzimmer", port: 8060, type: "player" },
        { name: "Schlafzimmer", port: 8061, type: "tv" },
      ],
    });
    await ctx.i.onReady();

    expect(ctx.ecp).toHaveLength(2);
    expect(ctx.ecp[0].start).toHaveBeenCalledTimes(1);
    // Object tree: device + command + keys channel + one state per key.
    expect(ctx.i.objects.get("Wohnzimmer")?.type).toBe("device");
    expect(ctx.i.objects.get("Wohnzimmer.command")).toBeDefined();
    expect(ctx.i.objects.has("Wohnzimmer.commandType")).toBe(false);
    expect(ctx.i.objects.get("Wohnzimmer.keys")?.type).toBe("channel");
    expect(ctx.i.objects.get("Wohnzimmer.keys.Home")?.type).toBe("state");
    // A TV carries more keys than a player — the type must reach keysForType.
    const playerKeys = [...ctx.i.objects.keys()].filter(k => k.startsWith("Wohnzimmer.keys.")).length;
    const tvKeys = [...ctx.i.objects.keys()].filter(k => k.startsWith("Schlafzimmer.keys.")).length;
    expect(tvKeys).toBeGreaterThan(playerKeys);
    expect(ctx.i.states.get("info.connection")).toEqual({ val: true, ack: true });
  });

  it("keeps the object tree of a device whose server could not start", async () => {
    const ctx = setup(twoPlayers(), { failEcpPort: 8060 });
    await ctx.i.onReady();
    // The device is still configured. Its states — and whatever the user attached to
    // them, history for one — must survive until the port conflict is fixed, not be
    // swept as orphans on every restart while the log says "fix the port".
    expect(ctx.i.objects.get("Wohnzimmer.keys.Home")?.type).toBe("state");
    expect(ctx.i.objects.get("Kueche.keys.Home")?.type).toBe("state");
  });

  it("loads the admin translations from the adapter's admin folder", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    // adapter-core looks for `<root>/i18n` — pointing at admin/i18n directly would
    // throw at start-up and leave every device-manager label untranslated.
    expect(I18n.init).toHaveBeenCalledWith(join("/tmp/fakeroku", "admin"), ctx.adapter);
  });

  it("closes an ECP server whose start failed, so nothing of it outlives the device loop", async () => {
    const ctx = setup({}, { failEcpPort: 8060 });
    await ctx.i.onReady();
    expect(ctx.ecp[0].stop).toHaveBeenCalledTimes(1);
  });

  it("names the keys channel from admin/i18n, not from a hard-coded string", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    expect(ctx.i.objects.get("Wohnzimmer.keys")).toMatchObject({
      common: { name: { en: "channelKeys" }, desc: { en: "channelKeysDesc" } },
    });
  });

  it("keys are read-only booleans with the gate-conformant role", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    const key = ctx.i.objects.get("Wohnzimmer.keys.Home") as { common: Record<string, unknown> };
    // role "button.press" is what the docs suggest but the repochecker rejects
    // (E1010); write:true would offer a control the adapter never reads.
    expect(key.common).toMatchObject({ type: "boolean", role: "sensor", read: true, write: false });
  });

  it("a busy port takes down only its own device, not the others", async () => {
    const ctx = setup(
      {
        devices: [
          { name: "Wohnzimmer", port: 8060, type: "player" },
          { name: "Schlafzimmer", port: 8061, type: "player" },
        ],
      },
      { failEcpPort: 8060 },
    );
    await ctx.i.onReady();

    expect(ctx.i.log.warn).toHaveBeenCalledWith(
      'Emulated Roku "Wohnzimmer" is not running — port 8060 is already in use (another program or another instance holds it); retrying every 60 s',
    );
    // The surviving device keeps working and gets announced …
    expect(ctx.ssdps[0].options.devices as unknown[]).toHaveLength(1);
  });

  it("reports disconnected while any configured device is missing", async () => {
    const ctx = setup(
      {
        devices: [
          { name: "Wohnzimmer", port: 8060, type: "player" },
          { name: "Schlafzimmer", port: 8061, type: "player" },
        ],
      },
      { failEcpPort: 8060 },
    );
    await ctx.i.onReady();

    // … but "connected" must not paper over the dead one: a taken port is a
    // configuration the user has to fix, and the only other trace is a log line.
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
    // Yellow: one warning about the missing one, no error — one Roku still runs.
    expect(ctx.i.log.error).not.toHaveBeenCalled();
    expect(ctx.i.log.info).toHaveBeenCalledWith(expect.stringContaining("Emulating 1 of 2 Roku device(s)"));
  });

  it("reports connected once every configured device is up", async () => {
    const ctx = setup({
      devices: [
        { name: "Wohnzimmer", port: 8060, type: "player" },
        { name: "Schlafzimmer", port: 8061, type: "player" },
      ],
    });
    await ctx.i.onReady();

    expect(ctx.i.states.get("info.connection")).toEqual({ val: true, ack: true });
    expect(ctx.i.log.error).not.toHaveBeenCalled();
    expect(ctx.i.log.info).toHaveBeenCalledWith(expect.stringContaining("Emulating 2 Roku device(s)"));
  });

  it("no Roku runs: one error naming each with its reason, no discovery, the instance stays up and retries", async () => {
    const ctx = setup({ devices: [{ name: "Wohnzimmer", port: 8060, type: "player" }] }, { failEcpPort: 8060 });
    await ctx.i.onReady();

    expect(ctx.i.log.error).toHaveBeenCalledTimes(1);
    expect(ctx.i.log.error).toHaveBeenCalledWith(
      'No emulated Roku is running — "Wohnzimmer": port 8060 is already in use (another program or another instance holds it); retrying every 60 s',
    );
    expect(ctx.i.log.warn).not.toHaveBeenCalled();
    expect(ctx.i.terminate).not.toHaveBeenCalled();
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
    // Nothing is listening, so there is nothing to announce — but the device is queued
    // for a retry rather than written off (a port taken at boot is usually a restart race).
    expect(ctx.ssdps).toHaveLength(0);
    expect(ctx.i.pending.map(p => p.name)).toEqual(["Wohnzimmer"]);
  });

  it("names the system's text for a listen error that is not a taken port", async () => {
    const ctx = setup({ devices: [{ name: "Wohnzimmer", port: 8060, type: "player" }] });
    ctx.i.makeEcpServer = (options: Record<string, unknown>) => {
      const server = fakeEcp(options, () => Promise.reject(new Error("listen EACCES: permission denied 0.0.0.0:80")));
      ctx.ecp.push(server);
      return server;
    };
    await ctx.i.onReady();
    expect(ctx.i.log.error).toHaveBeenCalledWith(
      'No emulated Roku is running — "Wohnzimmer": port 8060: listen EACCES: permission denied 0.0.0.0:80; retrying every 60 s',
    );
  });

  it("gives up only when no device is startable at all, and says why", async () => {
    // Every row unusable for a reason a retry cannot fix (here: the reserved name).
    const ctx = setup({ devices: [{ name: "info", port: 8060, type: "player" }] });
    await ctx.i.onReady();

    expect(ctx.i.log.error).toHaveBeenCalledWith(
      'No emulated Roku is running — "info": its object id "info" is reserved for the adapter\'s own status',
    );
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
    expect(ctx.i.pending).toHaveLength(0);
  });

  it("skips a second device whose name maps to the same object id", async () => {
    const ctx = setup({
      devices: [
        { name: "Wohn Zimmer", port: 8060, type: "player" },
        { name: "Wohn/Zimmer", port: 8061, type: "player" },
      ],
    });
    await ctx.i.onReady();

    // Both sanitize to wohn_zimmer — letting both run means two devices fighting
    // over one object tree, and the second one's keys overwriting the first's.
    expect(ctx.ecp).toHaveLength(1);
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("already in use"));
    // A hand-edited duplicate is a broken configuration like a taken port — one
    // of the two configured devices never runs, so the instance says so.
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
  });

  it("keeps a dashed uuid from an older configuration", async () => {
    const ctx = setup({
      devices: [{ name: "Wohnzimmer", port: 8060, type: "player", uuid: "123e4567-e89b-12d3-a456-426614174000" }],
    });
    await ctx.i.onReady();
    expect((ctx.ecp[0].options.device as { uuid: string }).uuid).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(ctx.i.log.warn).not.toHaveBeenCalled();
  });

  it("no Roku configured: an error asking to add one, yellow, and the instance stays up for the device manager", async () => {
    const ctx = setup({ devices: [] });
    await ctx.i.onReady();
    expect(ctx.i.log.error).toHaveBeenCalledWith(
      "No Roku device configured — add one in the instance settings (device manager)",
    );
    expect(ctx.i.terminate).not.toHaveBeenCalled();
    expect(ctx.ecp).toHaveLength(0);
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
  });

  it("ignores config entries without a usable name", async () => {
    const ctx = setup({
      devices: [{ name: "", port: 8060 }, { port: 8061 }, null, { name: "Echt", port: 8062, type: "player" }],
    });
    await ctx.i.onReady();
    expect(ctx.ecp).toHaveLength(1);
    expect(ctx.i.objects.get("Echt")?.type).toBe("device");
    // The unusable rows are dropped BEFORE the completeness check — they carry no
    // name to report, so counting them would turn the instance red with nothing
    // in the log to act on.
    expect(ctx.i.states.get("info.connection")).toEqual({ val: true, ack: true });
  });
});

describe("Fakeroku onReady — device identity", () => {
  it("advertises the persisted device id unchanged — the identity IS the pairing", async () => {
    const ctx = setup({ devices: [{ name: "Wohnzimmer", port: 8060, type: "player", uuid: "keep-me" }] });
    await ctx.i.onReady();
    expect((ctx.ecp[0].options.device as { uuid: string }).uuid).toBe("keep-me");
    expect(ctx.i.log.warn).not.toHaveBeenCalled();
  });

  it("derives the id from the STORED name for a row that carries none", async () => {
    // The manifest's default device has no uuid. This is the identity the device
    // manager has to persist on an edit — deriving from the new name there would
    // move the USN on a plain rename and unpair the remote.
    const ctx = setup({ devices: [{ name: "Roku", port: 8060, type: "player" }] });
    await ctx.i.onReady();
    expect((ctx.ecp[0].options.device as { uuid: string }).uuid).toBe(deriveUuid("Roku"));
  });

  it("replaces an unusable stored id and says so", async () => {
    // The id goes verbatim into SSDP headers and the description XML — a hand-edited value with
    // line breaks would inject headers. Only the shapes the adapters ever wrote pass.
    const ctx = setup({ devices: [{ name: "Roku", port: 8060, type: "player", uuid: "x\r\nUSN: evil" }] });
    await ctx.i.onReady();
    expect((ctx.ecp[0].options.device as { uuid: string }).uuid).toBe(deriveUuid("Roku"));
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("unusable device id"));
  });
});

describe("Fakeroku onReady — a device nothing has seen yet gets its own identity", () => {
  it("writes a random identity and the object id on the first start of a fresh instance, then restarts", async () => {
    // Derived from the name, the default "Roku" announced the same USN from every ioBroker in a
    // network and from both instances on one host.
    const ctx = setup({ devices: [{ name: "Roku", port: 8060, type: "player" }] }, { fresh: true });
    await ctx.i.onReady();
    const stored = ctx.i.instanceNative.devices as { uuid: string; objectId: string }[];
    expect(stored[0].uuid).toMatch(/^[0-9a-f]{32}$/);
    expect(stored[0].uuid).not.toBe(deriveUuid("Roku"));
    expect(stored[0].objectId).toBe("Roku");
    // The write restarts the instance — nothing may be announced under the old identity first.
    expect(ctx.ecp).toHaveLength(0);
    expect(ctx.i.log.info).toHaveBeenCalledWith(expect.stringContaining("got its own network identity"));
  });

  it("leaves a device alone that has a tree — it has been announced, maybe paired", async () => {
    const ctx = setup({ devices: [{ name: "Roku", port: 8060, type: "player" }] });
    await ctx.i.onReady();
    expect(ctx.i.extendForeignObjectAsync).not.toHaveBeenCalled();
    expect((ctx.ecp[0].options.device as { uuid: string }).uuid).toBe(deriveUuid("Roku"));
  });

  it("starts with the derived identity when the write fails, and tries again next start", async () => {
    const ctx = setup({ devices: [{ name: "Roku", port: 8060, type: "player" }] }, { fresh: true });
    ctx.i.extendForeignObjectAsync.mockRejectedValueOnce(new Error("write refused"));
    await ctx.i.onReady();
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("settings could not be completed"));
    expect((ctx.ecp[0].options.device as { uuid: string }).uuid).toBe(deriveUuid("Roku"));
  });
});

describe("Fakeroku onReady — identities side by side", () => {
  it("a new device gets its own identity, an existing one next to it keeps the one it has", async () => {
    const ctx = setup(
      {
        devices: [
          { name: "Alt", port: 8060, type: "player" },
          { name: "Neu", port: 8061, type: "player" },
        ],
      },
      { fresh: true },
    );
    ctx.i.objects.set("Alt", { type: "device", common: { name: "Alt" }, native: {} });
    await ctx.i.onReady();
    const stored = ctx.i.instanceNative.devices as { name: string; uuid: string }[];
    expect(stored[0].uuid).toBe(deriveUuid("Alt"));
    expect(stored[1].uuid).toMatch(/^[0-9a-f]{32}$/);
    expect(stored[1].uuid).not.toBe(deriveUuid("Neu"));
  });
});

describe("Fakeroku onReady — an installation upgraded from the old adapter keeps its tree", () => {
  it("uses the tree the old adapter built for a name with an umlaut, and keeps it", async () => {
    // Old adapter: "Küche" → object id "Küche"; the rebuild's rule gives "K_che". Before, the
    // sweep deleted "Küche" with its values, room assignments and history settings.
    const ctx = setup({ devices: [{ name: "Küche", port: 9093, uuid: "legacy-uuid" }] }, { fresh: true });
    ctx.i.objects.set("Küche", { type: "device", common: { name: "Küche" }, native: {} });
    ctx.i.objects.set("Küche.keys.Home", { type: "state", common: { name: "Home" }, native: {} });
    ctx.i.states.set("Küche.keys.Home", { val: false, ack: true });
    ctx.i.enums.set("enum.rooms.kitchen", new Set(["fakeroku.0.Küche.keys.Home"]));

    await ctx.i.onReady();

    expect(ctx.i.objects.has("Küche.keys.Home")).toBe(true);
    expect(ctx.i.objects.has("K_che")).toBe(false);
    expect(ctx.i.enums.get("enum.rooms.kitchen")!.has("fakeroku.0.Küche.keys.Home")).toBe(true);
  });

  it("writes the type a row without one reads from its TV keys into the settings, once, and keeps the keys", async () => {
    const ctx = setup({ devices: [{ name: "TV", port: 9093, uuid: "legacy-tv" }] }, { fresh: true });
    ctx.i.objects.set("TV", { type: "device", common: { name: "TV" }, native: {} });
    ctx.i.objects.set("TV.keys.VolumeUp", { type: "state", common: { name: "VolumeUp" }, native: {} });

    await ctx.i.onReady();

    // The first start writes the derived type and restarts — nothing starts, nothing is swept.
    const stored = ctx.i.instanceNative.devices as { type?: string; port: number; uuid: string; objectId: string }[];
    expect(stored[0]).toMatchObject({ type: "tv", port: 9093, uuid: "legacy-tv", objectId: "TV" });
    expect(ctx.ecp).toHaveLength(0);
    expect(ctx.i.objects.has("TV.keys.VolumeUp")).toBe(true);
    expect(ctx.i.log.info).toHaveBeenCalledWith(expect.stringContaining("now carries its type in the settings"));

    // The restart reads the written row: a TV, and nothing more to write.
    ctx.i.config = structuredClone(ctx.i.instanceNative);
    await ctx.i.onReady();
    expect(ctx.i.extendForeignObjectAsync).toHaveBeenCalledTimes(1);
    expect((ctx.ecp[0].options as { deviceType: string }).deviceType).toBe("tv");
    expect(ctx.i.objects.has("TV.keys.VolumeUp")).toBe(true);
    expect(ctx.i.objects.has("TV.keys.InputTuner")).toBe(true);
  });

  it("writes a row without a type and with an unusable port as a player on the old adapter's 9093", async () => {
    const ctx = setup({ devices: [{ name: "Alt", port: "", uuid: "legacy-alt" }] });
    await ctx.i.onReady();
    const stored = ctx.i.instanceNative.devices as { type?: string; port: number }[];
    expect(stored[0]).toMatchObject({ type: "player", port: 9093 });

    ctx.i.config = structuredClone(ctx.i.instanceNative);
    await ctx.i.onReady();
    expect((ctx.ecp[0].options.device as { port: number }).port).toBe(9093);
    expect(ctx.i.extendForeignObjectAsync).toHaveBeenCalledTimes(1);
  });

  it("writes nothing for a row that carries its type", async () => {
    const ctx = setup({ devices: [{ name: "Wohnzimmer", port: 8060, type: "tv" }] });
    await ctx.i.onReady();
    expect(ctx.i.extendForeignObjectAsync).not.toHaveBeenCalled();
    expect(ctx.ecp).toHaveLength(1);
  });
});

describe("Fakeroku onReady — names and descriptions", () => {
  it("gives every object it creates a translation object, never a bare string", async () => {
    const ctx = setup({ devices: [{ name: "Wohnzimmer", port: 8060, type: "tv" }] });
    await ctx.i.onReady();
    for (const [id, obj] of ctx.i.objects) {
      const common = (obj as { common?: Record<string, unknown> }).common ?? {};
      expect(typeof common.name, `${id} common.name`).not.toBe("string");
      if (common.desc !== undefined) {
        expect(typeof common.desc, `${id} common.desc`).not.toBe("string");
      }
    }
  });

  it("names the command datapoints from admin/i18n and explains them", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    expect(ctx.i.objects.get("Wohnzimmer.command")).toMatchObject({
      common: { name: { en: "stateLastCommand" }, desc: { en: "stateLastCommandDesc" } },
    });
  });

  it("wraps the protocol key name and the user's device name as translation objects", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    // Nothing to translate in either — but common.name must be an object for
    // every object type, so the object browser shows it in any system language.
    const key = ctx.i.objects.get("Wohnzimmer.keys.Home") as { common: { name: Record<string, string> } };
    expect(key.common.name.en).toBe("Home");
    expect(Object.keys(key.common.name)).toHaveLength(11);
    const device = ctx.i.objects.get("Wohnzimmer") as { common: { name: Record<string, string> } };
    expect(device.common.name.de).toBe("Wohnzimmer");
    // A key carries no description — its name already says everything.
    expect((key as { common: { desc?: unknown } }).common.desc).toBeUndefined();
  });

  it("re-applies its own info objects on EVERY start, so an update reaches an existing tree", async () => {
    // js-controller applies the manifest's instanceObjects on every start but keeps the
    // stored common.name. Without this an installation that already has them would keep the
    // old names for good and the manifest change would be cosmetic.
    const ctx = setup();
    ctx.i.objects.set("info", { type: "channel", common: { name: "Information" }, native: {} });
    ctx.i.objects.set("info.connection", {
      type: "state",
      common: { name: "Device or service connected", type: "boolean", role: "indicator.connected" },
      native: {},
    });
    await ctx.i.onReady();
    expect(ctx.i.objects.get("info")).toMatchObject({ type: "channel", common: { name: { en: "channelInfo" } } });
    expect(ctx.i.objects.get("info.connection")).toMatchObject({
      common: { name: { en: "connectionStatus" }, desc: { en: "connectionStatusDesc" }, role: "indicator.connected" },
    });
  });

  it("leaves its own info objects alone once they carry the current texts — no rewrite on every start", async () => {
    // Every unchanged write still stamps ts and reaches every subscriber.
    const ctx = setup();
    ctx.i.objects.set("info", {
      type: "channel",
      common: { name: { en: "channelInfo", de: "channelInfo" } },
      native: {},
    });
    ctx.i.objects.set("info.connection", {
      type: "state",
      common: {
        name: { en: "connectionStatus", de: "connectionStatus" },
        desc: { en: "connectionStatusDesc", de: "connectionStatusDesc" },
      },
      native: {},
    });
    await ctx.i.onReady();
    const written = ctx.i.extendObject.mock.calls.map(([id]) => id as string);
    expect(written).not.toContain("info");
    expect(written).not.toContain("info.connection");
  });
});

describe("Fakeroku onReady — reserved object ids", () => {
  it("skips a hand-edited device named 'info' instead of overwriting the status channel", async () => {
    const ctx = setup({ devices: [{ name: "info", port: 8060, type: "player" }] });
    // The instance objects js-controller created from the manifest.
    ctx.i.objects.set("info", { type: "channel", common: { name: "Information" }, native: {} });
    ctx.i.objects.set("info.connection", { type: "state", common: {}, native: {} });
    await ctx.i.onReady();

    expect(ctx.i.objects.get("info")?.type).toBe("channel");
    expect(ctx.i.objects.get("info.command")).toBeUndefined();
    expect(ctx.i.objects.get("info.keys.Home")).toBeUndefined();
    expect(ctx.i.log.error).toHaveBeenCalledWith(expect.stringContaining("is reserved for the adapter's own status"));
    // Nothing is controllable, so the instance must not claim to be connected.
    expect(ctx.i.states.get("info.connection")?.val).toBe(false);
  });

  it("starts the other devices when only one row carries a reserved name", async () => {
    const ctx = setup({
      devices: [
        { name: "info", port: 8060, type: "player" },
        { name: "Wohnzimmer", port: 8061, type: "player" },
      ],
    });
    await ctx.i.onReady();
    expect(ctx.ecp).toHaveLength(1);
    expect(ctx.i.objects.get("Wohnzimmer.command")).toBeDefined();
    // One configured device could not start — connected means EVERY device runs.
    expect(ctx.i.states.get("info.connection")?.val).toBe(false);
  });

  it("removes the leftovers of an earlier run that did create them", async () => {
    const ctx = setup();
    ctx.i.objects.set("info", { type: "channel", common: {}, native: {} });
    ctx.i.objects.set("info.connection", { type: "state", common: {}, native: {} });
    ctx.i.objects.set("info.command", { type: "state", common: {}, native: {} });
    ctx.i.objects.set("info.keys", { type: "channel", common: {}, native: {} });
    ctx.i.objects.set("info.keys.Home", { type: "state", common: {}, native: {} });
    await ctx.i.onReady();
    expect(ctx.i.objects.get("info.command")).toBeUndefined();
    expect(ctx.i.objects.get("info.keys")).toBeUndefined();
    expect(ctx.i.objects.get("info.keys.Home")).toBeUndefined();
    expect(ctx.i.objects.get("info.connection")).toBeDefined();
  });
});

describe("Fakeroku onReady — key states are released at start-up", () => {
  it("resets a key left true by a crash or a stop inside the pulse window", async () => {
    const ctx = setup();
    // What the states database looks like after the adapter went down mid-press:
    // onUnload drops the pulse timer, so the scheduled false was never written.
    ctx.i.states.set("Wohnzimmer.keys.Home", { val: true, ack: true });
    ctx.i.states.set("Wohnzimmer.keys.Play", { val: true, ack: true });
    await ctx.i.onReady();
    expect(ctx.i.states.get("Wohnzimmer.keys.Home")?.val).toBe(false);
    expect(ctx.i.states.get("Wohnzimmer.keys.Play")?.val).toBe(false);
  });

  it("releases a key that a lost keyup pinned true", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.applyCommand("Wohnzimmer", { type: "keydown", key: "Select" });
    expect(ctx.i.states.get("Wohnzimmer.keys.Select")?.val).toBe(true);
    await new Promise<void>(resolve => ctx.i.onUnload(resolve));
    // Teardown does NOT write the release — that is deliberate, the shutdown budget
    // carries one write. The next start is what clears it.
    expect(ctx.i.states.get("Wohnzimmer.keys.Select")?.val).toBe(true);

    const restarted = setup();
    restarted.i.states.set("Wohnzimmer.keys.Select", { val: true, ack: true });
    await restarted.i.onReady();
    expect(restarted.i.states.get("Wohnzimmer.keys.Select")?.val).toBe(false);
  });

  it("writes info.connection only when it changes — not at every step of the start", async () => {
    // The start passes false, the report after it passes the result: a stored false that stays
    // false is written by neither, and a start that ends connected writes exactly once.
    const stays = setup({ devices: [{ name: "Wohnzimmer", port: 8060, type: "player" }] }, { failEcpPort: 8060 });
    stays.i.states.set("info.connection", { val: false, ack: true });
    await stays.i.onReady();
    expect(stays.i.written).not.toContain("info.connection");

    const comesUp = setup();
    comesUp.i.states.set("info.connection", { val: false, ack: true });
    await comesUp.i.onReady();
    expect(comesUp.i.written.filter(id => id === "info.connection")).toHaveLength(1);
    expect(comesUp.i.states.get("info.connection")).toEqual({ val: true, ack: true });
  });

  it("touches no key that is already false", async () => {
    // Compared against the start's bulk read: a healthy tree must not get 27 pointless writes
    // (and 27 fresh timestamps) on every single adapter start.
    const ctx = setup();
    ctx.i.states.set("Wohnzimmer.keys.Home", { val: false, ack: true });
    ctx.i.states.set("Wohnzimmer.keys.Select", { val: true, ack: true });

    await ctx.i.onReady();

    // Against the ids a write actually REACHED, not the calls: the reset only ever passes
    // { val: false }, so filtering the calls for a value other than false can never find
    // anything and the assertion would hold with the skipping removed.
    expect(ctx.i.written).toContain("Wohnzimmer.keys.Select");
    expect(ctx.i.written).not.toContain("Wohnzimmer.keys.Home");
    expect(ctx.i.states.get("Wohnzimmer.keys.Home")).toEqual({ val: false, ack: true });
    expect(ctx.i.states.get("Wohnzimmer.keys.Select")).toEqual({ val: false, ack: true });
  });

  it("starts when the bulk read carries an empty entry", async () => {
    // js-controller lists the keys first and reads the values after: a state that expired in
    // between comes back as null, and reading val from it would end the start.
    const ctx = setup();
    ctx.i.states.set("Wohnzimmer.keys.Select", null as unknown as { val: unknown; ack: boolean });
    await ctx.i.onReady();
    expect(ctx.i.log.error).not.toHaveBeenCalled();
    expect(ctx.i.states.get("info.connection")).toEqual({ val: true, ack: true });
  });

  it("resets only the keys the device type actually carries", async () => {
    const ctx = setup({ devices: [{ name: "Wohnzimmer", port: 8060, type: "player" }] });
    ctx.i.states.set("Wohnzimmer.keys.Home", { val: true, ack: true });
    ctx.i.states.set("Wohnzimmer.keys.VolumeUp", { val: true, ack: true });
    await ctx.i.onReady();
    expect(ctx.i.written).toContain("Wohnzimmer.keys.Home");
    // VolumeUp is a TV key — a player has no such object, so nothing may be written to it.
    expect(ctx.i.written).not.toContain("Wohnzimmer.keys.VolumeUp");
  });

  it("resets every configured device, not just the first", async () => {
    const ctx = setup({
      devices: [
        { name: "Wohnzimmer", port: 8060, type: "player" },
        { name: "Schlafzimmer", port: 8061, type: "tv" },
      ],
    });
    ctx.i.states.set("Wohnzimmer.keys.Home", { val: true, ack: true });
    ctx.i.states.set("Schlafzimmer.keys.VolumeUp", { val: true, ack: true });
    await ctx.i.onReady();
    expect(ctx.i.states.get("Wohnzimmer.keys.Home")?.val).toBe(false);
    expect(ctx.i.states.get("Schlafzimmer.keys.VolumeUp")?.val).toBe(false);
  });
});

describe("Fakeroku cleanup of stale objects", () => {
  it("removes a device tree that is no longer configured", async () => {
    const ctx = setup();
    // Left over from an earlier config: a device that is gone now.
    ctx.i.objects.set("altgeraet", { type: "device" });
    ctx.i.objects.set("altgeraet.command", { type: "state" });
    ctx.i.objects.set("altgeraet.keys.Home", { type: "state" });

    await ctx.i.onReady();

    expect(ctx.i.objects.has("altgeraet")).toBe(false);
    expect(ctx.i.objects.has("altgeraet.keys.Home")).toBe(false);
    expect(ctx.i.objects.get("Wohnzimmer")).toBeDefined();
    // Routine housekeeping after an update or a config change — debug, like the
    // other adapters' cleanups; the log keeps info for events the user acts on.
    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("orphaned object"));
  });

  it("removes the commandType datapoint an installation up to 1.8.2 carries, value included", async () => {
    const ctx = setup();
    ctx.i.objects.set("Wohnzimmer.commandType", { type: "state", common: { type: "string" }, native: {} });
    ctx.i.states.set("Wohnzimmer.commandType", { val: "keypress", ack: true });

    await ctx.i.onReady();

    expect(ctx.i.objects.has("Wohnzimmer.commandType")).toBe(false);
    expect(ctx.i.states.has("Wohnzimmer.commandType")).toBe(false);
    // Only the retired datapoint goes — the device and its command stay.
    expect(ctx.i.objects.get("Wohnzimmer.command")).toBeDefined();
    expect(ctx.i.objects.get("Wohnzimmer.keys.Home")).toBeDefined();
  });

  it("keeps the info channel and says nothing when there is nothing to remove", async () => {
    const ctx = setup();
    ctx.i.objects.set("info", { type: "channel" });
    ctx.i.objects.set("info.connection", { type: "state" });

    await ctx.i.onReady();

    expect(ctx.i.objects.has("info.connection")).toBe(true);
    expect(ctx.i.log.debug).not.toHaveBeenCalledWith(expect.stringContaining("orphaned object"));
  });

  it("removes the last device's tree after the user deleted it", async () => {
    // The device manager writes an EMPTY list when the last Roku is deleted. Before
    // 1.5.0 onReady returned on that list before the sweep ran, so the deleted
    // device kept its object, its command states and all its keys — forever, because
    // no other path ever removes them.
    const ctx = setup({ devices: [] });
    ctx.i.objects.set("Wohnzimmer", { type: "device" });
    ctx.i.objects.set("Wohnzimmer.command", { type: "state" });
    ctx.i.objects.set("Wohnzimmer.keys.Home", { type: "state" });

    await ctx.i.onReady();

    expect(ctx.i.objects.has("Wohnzimmer")).toBe(false);
    expect(ctx.i.objects.has("Wohnzimmer.keys.Home")).toBe(false);
    // The adapter's own status survives the sweep.
    expect(ctx.i.objects.has("info.connection")).toBe(true);
  });

  it("removes a deleted device even when no routable address is left", async () => {
    // What belongs in the tree is decided by the configuration, not by the network:
    // a host that lost its address must not resurrect a device the user removed.
    noAddressYet();
    const ctx = setup({ bind: "", devices: [] });
    ctx.i.objects.set("Wohnzimmer", { type: "device" });

    await ctx.i.onReady();

    expect(ctx.i.log.error).toHaveBeenCalledWith(expect.stringContaining("No Roku device configured"));
    expect(ctx.i.objects.has("Wohnzimmer")).toBe(false);
  });

  it("sweeps nothing when the config carries no devices key at all", async () => {
    // `devices: undefined` is not "the user deleted everything" — it is a config we
    // could not read (or an instance nobody ever configured). Treating it as an empty
    // list would trade a tree that stays for a tree that is gone.
    const ctx = setup({ devices: undefined });
    ctx.i.objects.set("Wohnzimmer", { type: "device" });
    ctx.i.objects.set("Wohnzimmer.keys.Home", { type: "state" });

    await ctx.i.onReady();

    expect(ctx.i.objects.has("Wohnzimmer")).toBe(true);
    expect(ctx.i.objects.has("Wohnzimmer.keys.Home")).toBe(true);
  });
});

describe("Fakeroku — the configured row is read once, for everyone", () => {
  it("derives object id and identity from the name AS STORED", async () => {
    // The manager may display and save a trimmed name; the runtime must keep answering
    // for the tree and the SSDP identity the installation already has.
    const ctx = setup({ devices: [{ name: " Wohnzimmer ", port: 8060, type: "player" }] });
    await ctx.i.onReady();

    // A key state only the adapter creates, under the id built from the STORED name.
    expect(ctx.i.objects.has("_Wohnzimmer_.keys.Home")).toBe(true);
    expect(ctx.i.objects.has("Wohnzimmer")).toBe(false);
    expect((ctx.ecp[0].options.device as { uuid: string }).uuid).toBe(deriveUuid(" Wohnzimmer "));
  });

  it("replaces a port no server could bind and names it", async () => {
    const ctx = setup({ devices: [{ name: "Wohnzimmer", port: -5, type: "player" }] });
    await ctx.i.onReady();

    expect((ctx.ecp[0].options.device as { port: number }).port).toBe(8060);
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("unusable ECP port"));
  });

  it("ignores a row whose name is nothing but whitespace", async () => {
    const ctx = setup({ devices: [{ name: "   ", port: 8060, type: "player" }] });
    await ctx.i.onReady();

    expect(ctx.ecp).toHaveLength(0);
    expect(ctx.i.log.error).toHaveBeenCalledWith(expect.stringContaining("No Roku device configured"));
  });
});

describe("Fakeroku — leftovers of an older version inside an object", () => {
  it("removes a native attribute this version does not write, keeping the user's own common", async () => {
    // The pre-0.5.0 adapter wrote native.url on every key state. extendObject MERGES, so
    // it survives every update — and writing null would store null, not remove it. Only
    // writing the object whole (setForeignObject) removes it, and that write must carry
    // common.custom (the user's history configuration) unchanged.
    const ctx = setup();
    ctx.i.objects.set("Wohnzimmer.keys.Home", {
      type: "state",
      common: { name: "Home", type: "boolean", custom: { "history.0": { enabled: true } } },
      native: { url: "keys/Home" },
    });

    await ctx.i.onReady();

    const obj = ctx.i.objects.get("Wohnzimmer.keys.Home")!;
    expect(obj.native).toEqual({});
    expect((obj.common as { custom: unknown }).custom).toEqual({ "history.0": { enabled: true } });
    // And the update still reached the datapoint: the bare string the old adapter stored
    // is a translation object now (tRaw carries the key name in all eleven languages).
    const name = (obj.common as { name: Record<string, string> }).name;
    expect(name).toMatchObject({ en: "Home", de: "Home", "zh-cn": "Home" });
    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("stale native attribute"));
  });

  it("rewrites the object in place, so the value and the enum membership survive", async () => {
    // delObject does not merely forget the object: for a state js-controller ALSO drops the
    // value (delForeignState) and strips the id from every enum it belongs to. Repairing a
    // leftover that way costs the user the last recorded command and the room the datapoint
    // was sorted into — a repair must never cost more than the leftover it removes.
    const ctx = setup();
    ctx.i.objects.set("Wohnzimmer.command", {
      type: "state",
      common: { name: "Command", type: "string", def: "", custom: { "history.0": { enabled: true } } },
      native: { url: "keys/Home" },
    });
    ctx.i.states.set("Wohnzimmer.command", { val: "Home", ack: true });
    ctx.i.enums.set("enum.rooms.wohnzimmer", new Set(["fakeroku.0.Wohnzimmer.command"]));

    await ctx.i.onReady();

    const obj = ctx.i.objects.get("Wohnzimmer.command")!;
    expect(obj.native).toEqual({});
    expect((obj.common as { custom: unknown }).custom).toEqual({ "history.0": { enabled: true } });
    expect(ctx.i.states.get("Wohnzimmer.command")).toEqual({ val: "Home", ack: true });
    expect(ctx.i.enums.get("enum.rooms.wohnzimmer")).toEqual(new Set(["fakeroku.0.Wohnzimmer.command"]));
  });

  it("leaves an object alone when its native is already empty", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.delObjectAsync.mockClear();
    ctx.i.setForeignObject.mockClear();

    await ctx.i.onReady();

    // Nothing to repair means nothing is written — neither taken away nor rewritten. A start
    // that rewrote every object would fire an objectChange per datapoint at every history
    // adapter and script, on every start.
    expect(ctx.i.delObjectAsync).not.toHaveBeenCalled();
    expect(ctx.i.setForeignObject).not.toHaveBeenCalled();
  });
});

describe("Fakeroku start-up robustness", () => {
  it("reports a failing start-up instead of dying on an unhandled rejection", async () => {
    const ctx = setup();
    // The objects database refusing a write. (Not getAdapterObjectsAsync: js-controller's
    // `_getAdapterObjects` never rejects — each view sits in its own try/catch.)
    ctx.i.extendObject.mockRejectedValue(new Error("objects db down"));
    // onReady is an event handler: an escaping rejection is an unhandled rejection
    // and js-controller restarts the instance in a loop with nothing in the log.
    await expect(ctx.i.onReady()).resolves.toBeUndefined();
    expect(ctx.i.log.error).toHaveBeenCalledWith(expect.stringContaining("onReady failed: objects db down"));
  });

  it("treats a missing devices list like an empty one", async () => {
    const ctx = setup({ devices: undefined });
    await ctx.i.onReady();
    // A never-configured instance has no `devices` key at all — reading it as a
    // list must not throw before the "configure a device" hint is logged.
    expect(ctx.i.log.error).toHaveBeenCalledWith(
      "No Roku device configured — add one in the instance settings (device manager)",
    );
    expect(ctx.i.states.get("info.connection")?.val).not.toBe(true);
  });

  it("keeps cleaning up when one stale object cannot be deleted", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.objects.set("Buero", { type: "device", common: { name: "Buero" }, native: {} });
    ctx.i.objects.set("Flur", { type: "device", common: { name: "Flur" }, native: {} });
    const del = ctx.i.delObjectAsync;
    const real = del.getMockImplementation() as (id: string, o?: unknown) => Promise<void>;
    del.mockImplementation((id: string, o?: unknown) =>
      id.endsWith("Buero") ? Promise.reject(new Error("locked")) : real(id, o),
    );
    ctx.i.log.debug.mockClear();
    await ctx.i.onReady();
    // One undeletable leftover must not abort the sweep — the rest would stay
    // forever, and the failure has to be findable.
    expect(ctx.i.objects.has("Flur")).toBe(false);
    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("could not delete"));
  });

  it("survives a host that hands out no timer handle", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.setTimeout.mockReturnValue(undefined);
    // js-controller returns undefined from setTimeout once the adapter is
    // unloading. The key write must still happen and nothing may throw.
    expect(() => ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "Home" })).not.toThrow();
    expect(ctx.i.states.get("Wohnzimmer.keys.Home")).toEqual({ val: true, ack: true });
    expect(() => ctx.i.applyCommand("Wohnzimmer", { type: "keydown", key: "Select" })).not.toThrow();
    expect(ctx.i.states.get("Wohnzimmer.keys.Select")).toEqual({ val: true, ack: true });

    // Nothing was armed, so nothing may be booked for teardown: an `undefined`
    // in the timer lists becomes a js-controller warning per entry on unload.
    ctx.i.clearTimeout.mockClear();
    ctx.i.onUnload(() => {});
    expect(ctx.i.clearTimeout).not.toHaveBeenCalledWith(undefined);
    expect(ctx.i.clearTimeout).not.toHaveBeenCalled();

    ctx.i.clearTimeout.mockClear();
    let done: () => void = () => {};
    const p = new Promise<void>(r => (done = r));
    const started = ctx.i.startWithTimeout(p, 50);
    done();
    await expect(started).resolves.toBeUndefined();
    expect(ctx.i.clearTimeout).not.toHaveBeenCalled();
  });

  it("unloads cleanly when discovery never started", async () => {
    const ctx = setup({}, { ssdpStartFails: true });
    await ctx.i.onReady();
    ctx.i.clearInterval.mockClear();
    const cb = vi.fn();
    await new Promise<void>(resolve => ctx.i.onUnload(() => (cb(), resolve())));
    expect(ctx.i.clearInterval).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
