import { vi } from "vitest";
import type * as OsModule from "node:os";

/**
 * Orchestration tests for the adapter lifecycle. `@iobroker/adapter-core` is
 * stubbed with a minimal Adapter base class carrying an in-memory object/state
 * store, so the real object tree, the cleanup planner and the command→state
 * mapping all run for real. Only the two network-facing collaborators (ECP
 * server, SSDP responder) are replaced, through the factory seams in main.ts —
 * nothing here binds a port.
 */
vi.mock("@iobroker/adapter-core", () => {
  class Adapter {
    public log = { silly: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    public namespace = "fakeroku.0";
    public adapterDir = "/tmp/fakeroku";
    public config: Record<string, unknown> = {};
    public objects = new Map<string, Record<string, unknown>>();
    public states = new Map<string, { val: unknown; ack: boolean }>();
    public on = vi.fn();
    public setState = vi.fn((id: string, state: unknown) => {
      const s = state as { val?: unknown; ack?: boolean };
      this.states.set(id.replace(`${this.namespace}.`, ""), { val: s?.val, ack: s?.ack === true });
      return Promise.resolve();
    });
    // Writes only where the value actually differs — the js-controller contract the
    // startup key reset relies on, so a test can tell a real reset from a blind write.
    public setStateChangedAsync = vi.fn((id: string, state: unknown) => {
      const s = state as { val?: unknown; ack?: boolean };
      const key = id.replace(`${this.namespace}.`, "");
      if (this.states.get(key)?.val !== s?.val) {
        this.states.set(key, { val: s?.val, ack: s?.ack === true });
      }
      return Promise.resolve();
    });
    public extendObject = vi.fn((id: string, obj: Record<string, unknown>) => {
      const key = id.replace(`${this.namespace}.`, "");
      this.objects.set(key, { ...(this.objects.get(key) ?? {}), ...obj });
      return Promise.resolve();
    });
    public getAdapterObjectsAsync = vi.fn(() => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of this.objects) {
        out[`${this.namespace}.${k}`] = v;
      }
      return Promise.resolve(out);
    });
    public delObjectAsync = vi.fn((id: string, opts?: { recursive?: boolean }) => {
      const key = id.replace(`${this.namespace}.`, "");
      for (const k of [...this.objects.keys()]) {
        if (k === key || (opts?.recursive && k.startsWith(`${key}.`))) {
          this.objects.delete(k);
        }
      }
      return Promise.resolve();
    });
    public setInterval = vi.fn(() => ({ kind: "interval" }));
    public clearInterval = vi.fn();
    public setTimeout = vi.fn((_cb: () => void, _ms: number) => ({ kind: "timeout" }));
    public clearTimeout = vi.fn();
    constructor(_opts: unknown) {}
  }
  // getTranslatedObject is what tName/tDesc call for every common.name and desc.
  // The stub returns a recognisable object per key, so a test can assert WHICH key
  // an object was named from without depending on the wording of a translation.
  return {
    Adapter,
    I18n: {
      init: vi.fn(async () => {}),
      getTranslatedObject: vi.fn((key: string) => ({ en: key, de: key })),
    },
  };
});

/** os.networkInterfaces is swapped so the advertise-IP paths are deterministic. */
const osMock = vi.hoisted(() => ({ interfaces: null as Record<string, unknown[]> | null }));
vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof OsModule>();
  const networkInterfaces = (): unknown => osMock.interfaces ?? actual.networkInterfaces();
  return { ...actual, default: { ...actual, networkInterfaces }, networkInterfaces };
});

import { I18n } from "@iobroker/adapter-core";
import { join } from "node:path";
import { Fakeroku } from "./main";
import type { CommandEvent } from "./ecp/ecp-command";
import { EcpHttpServer } from "./ecp/ecp-http-server";
import { RokuSsdpResponder } from "./discovery/ssdp-responder";
import { deriveUuid } from "./lib/device-identity";

interface FakeEcp {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  options: Record<string, unknown>;
}
interface FakeSsdp {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  announce: ReturnType<typeof vi.fn>;
  options: Record<string, unknown>;
}

/**
 * Typed access to the private members the orchestration tests drive.
 *
 * @param adapter Adapter instance under test
 */
function internalOf(adapter: Fakeroku): {
  onReady(): Promise<void>;
  onUnload(cb: () => void): void;
  applyCommand(deviceId: string, cmd: CommandEvent): boolean;
  onSsdpFatal(): void;
  startWithTimeout(p: Promise<void>, ms: number): Promise<void>;
  objects: Map<string, Record<string, unknown>>;
  states: Map<string, { val: unknown; ack: boolean }>;
  config: Record<string, unknown>;
  log: Record<"debug" | "info" | "warn" | "error", ReturnType<typeof vi.fn>>;
  setTimeout: ReturnType<typeof vi.fn>;
  clearTimeout: ReturnType<typeof vi.fn>;
  setInterval: ReturnType<typeof vi.fn>;
  clearInterval: ReturnType<typeof vi.fn>;
  ssdp: FakeSsdp | undefined;
  deviceKeys: Map<string, ReadonlySet<string>>;
  pulseTimers: Set<unknown>;
  holdTimers: Map<string, unknown>;
  setState: ReturnType<typeof vi.fn>;
  setStateChangedAsync: ReturnType<typeof vi.fn>;
  makeEcpServer: unknown;
  makeSsdpResponder: unknown;
} {
  return adapter as never;
}

interface Ctx {
  adapter: Fakeroku;
  i: ReturnType<typeof internalOf>;
  ecp: FakeEcp[];
  ssdps: FakeSsdp[];
}

/**
 * Build an adapter with fake collaborators and a config.
 *
 * @param config native config fields for this run
 * @param opts   per-fake behaviour (which ECP port fails to start, SSDP failure)
 * @param opts.failEcpPort ECP port whose fake server fails to start
 * @param opts.ssdpStartFails Whether the fake SSDP responder fails to start
 */
function setup(
  config: Record<string, unknown> = {},
  opts: { failEcpPort?: number; ssdpStartFails?: boolean } = {},
): Ctx {
  const adapter = new Fakeroku();
  const i = internalOf(adapter);
  i.config = {
    devices: [{ name: "Wohnzimmer", port: 8060, type: "player" }],
    networkInterface: "192.168.1.5",
    ...config,
  };

  const ecp: FakeEcp[] = [];
  const ssdps: FakeSsdp[] = [];
  i.makeEcpServer = (options: Record<string, unknown>) => {
    const port = (options.device as { port: number }).port;
    const server: FakeEcp = {
      options,
      stop: vi.fn(),
      start: vi.fn(() => {
        if (opts.failEcpPort === port) {
          return Promise.reject(new Error(`EADDRINUSE ${port}`));
        }
        return Promise.resolve();
      }),
    };
    ecp.push(server);
    return server;
  };
  i.makeSsdpResponder = (options: Record<string, unknown>) => {
    const responder: FakeSsdp = {
      options,
      stop: vi.fn(),
      announce: vi.fn(),
      start: vi.fn(() => {
        if (opts.ssdpStartFails) {
          return Promise.reject(new Error("port 1900 busy"));
        }
        return Promise.resolve();
      }),
    };
    ssdps.push(responder);
    return responder;
  };
  return { adapter, i, ecp, ssdps };
}

afterEach(() => {
  osMock.interfaces = null;
});

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
    // Object tree: device + command + commandType + keys channel + one state per key.
    expect(ctx.i.objects.get("Wohnzimmer")?.type).toBe("device");
    expect(ctx.i.objects.get("Wohnzimmer.command")).toBeDefined();
    expect(ctx.i.objects.get("Wohnzimmer.commandType")).toBeDefined();
    expect(ctx.i.objects.get("Wohnzimmer.keys")?.type).toBe("channel");
    expect(ctx.i.objects.get("Wohnzimmer.keys.Home")?.type).toBe("state");
    // A TV carries more keys than a player — the type must reach keysForType.
    const playerKeys = [...ctx.i.objects.keys()].filter(k => k.startsWith("Wohnzimmer.keys.")).length;
    const tvKeys = [...ctx.i.objects.keys()].filter(k => k.startsWith("Schlafzimmer.keys.")).length;
    expect(tvKeys).toBeGreaterThan(playerKeys);
    expect(ctx.i.states.get("info.connection")).toEqual({ val: true, ack: true });
  });

  it("keeps the object tree of a device whose server could not start", async () => {
    const ctx = setup(
      {
        devices: [
          { name: "Wohnzimmer", port: 8060, type: "player" },
          { name: "Kueche", port: 8061, type: "player" },
        ],
      },
      { failEcpPort: 8060 },
    );
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

  it("commandType carries the fixed verb list as plain-string labels", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    const states = (ctx.i.objects.get("Wohnzimmer.commandType") as { common: { states: Record<string, unknown> } })
      .common.states;
    expect(Object.keys(states).sort()).toEqual(
      ["input", "install", "keydown", "keypress", "keyup", "launch", "search"].sort(),
    );
    // A translation object as a value is React error #31 in the admin's object view.
    for (const v of Object.values(states)) {
      expect(typeof v).toBe("string");
    }
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

    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("could not start on port 8060"));
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
    expect(ctx.i.log.error).toHaveBeenCalledWith(expect.stringContaining("Only 1 of 2 configured"));
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

  it("stops with an error when no device could be started", async () => {
    const ctx = setup({ devices: [{ name: "Wohnzimmer", port: 8060, type: "player" }] }, { failEcpPort: 8060 });
    await ctx.i.onReady();

    expect(ctx.i.log.error).toHaveBeenCalledWith(expect.stringContaining("No emulated Roku device could be started"));
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
    expect(ctx.ssdps).toHaveLength(0);
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

  it("keeps a device's persisted identity instead of re-deriving it", async () => {
    const ctx = setup({ devices: [{ name: "Wohnzimmer", port: 8060, type: "player", uuid: "kept-uuid-1234" }] });
    await ctx.i.onReady();
    // The identity IS the pairing: re-deriving it would unpair the remote.
    expect((ctx.ecp[0].options.device as { uuid: string }).uuid).toBe("kept-uuid-1234");
  });

  it("replaces a persisted device id that is not in a shape the adapters ever wrote", async () => {
    const ctx = setup({ devices: [{ name: "Wohnzimmer", port: 8060, type: "player", uuid: "x\r\nUSN: evil" }] });
    await ctx.i.onReady();
    // The id goes verbatim into SSDP headers and the description XML — a hand-edited
    // value with line breaks would inject headers. Only hex / dashed-uuid shapes pass.
    const uuid = (ctx.ecp[0].options.device as { uuid: string }).uuid;
    expect(uuid).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("unusable device id"));
  });

  it("keeps a dashed uuid from an older configuration", async () => {
    const ctx = setup({
      devices: [{ name: "Wohnzimmer", port: 8060, type: "player", uuid: "123e4567-e89b-12d3-a456-426614174000" }],
    });
    await ctx.i.onReady();
    expect((ctx.ecp[0].options.device as { uuid: string }).uuid).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(ctx.i.log.warn).not.toHaveBeenCalled();
  });

  it("warns and stops when no device is configured", async () => {
    const ctx = setup({ devices: [] });
    await ctx.i.onReady();
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("No emulated Roku devices configured"));
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
  it("advertises the persisted device id unchanged", async () => {
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
    const ctx = setup({ devices: [{ name: "Roku", port: 8060, type: "player", uuid: "not a/valid id" }] });
    await ctx.i.onReady();
    expect((ctx.ecp[0].options.device as { uuid: string }).uuid).toBe(deriveUuid("Roku"));
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("unusable device id"));
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
    expect(ctx.i.objects.get("Wohnzimmer.commandType")).toMatchObject({
      common: { name: { en: "stateLastCommandType" }, desc: { en: "stateLastCommandTypeDesc" } },
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
    // js-controller creates the manifest's instanceObjects only where they are
    // missing. Without this an installation that already has them would keep the
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

  it("repairs an info channel that a device row had turned into a device object", async () => {
    const ctx = setup();
    ctx.i.objects.set("info", { type: "device", common: { name: "info" }, native: {} });
    await ctx.i.onReady();
    expect(ctx.i.objects.get("info")?.type).toBe("channel");
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
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("reserves for its own status"));
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

  it("touches no key that is already false", async () => {
    // setStateChanged semantics: a healthy tree must not get 27 pointless writes
    // (and 27 fresh timestamps) on every single adapter start.
    const ctx = setup();
    ctx.i.states.set("Wohnzimmer.keys.Home", { val: false, ack: true });
    await ctx.i.onReady();
    const written = ctx.i.setStateChangedAsync.mock.calls.filter(
      (c: unknown[]) => (c[1] as { val: unknown }).val !== false,
    );
    expect(written).toHaveLength(0);
    expect(ctx.i.states.get("Wohnzimmer.keys.Home")).toEqual({ val: false, ack: true });
  });

  it("resets only the keys the device type actually carries", async () => {
    const ctx = setup({ devices: [{ name: "Wohnzimmer", port: 8060, type: "player" }] });
    await ctx.i.onReady();
    const ids = ctx.i.setStateChangedAsync.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(ids).toContain("Wohnzimmer.keys.Home");
    // VolumeUp is a TV key — a player has no such object, so nothing may be written to it.
    expect(ids).not.toContain("Wohnzimmer.keys.VolumeUp");
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

describe("Fakeroku onReady — network interface", () => {
  it("a configured interface pins both the bind and the announcement", async () => {
    const ctx = setup({ networkInterface: "192.168.1.5" });
    await ctx.i.onReady();
    expect(ctx.ecp[0].options.bindIp).toBe("192.168.1.5");
    expect(ctx.ssdps[0].options).toMatchObject({
      bindIp: "192.168.1.5",
      advertiseIp: "192.168.1.5",
      membershipInterfaces: ["192.168.1.5"],
    });
  });

  it('auto ("" or 0.0.0.0) binds everything and joins every routable interface', async () => {
    osMock.interfaces = {
      lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
      eth0: [{ family: "IPv4", address: "192.168.1.20", internal: false }],
      wlan0: [{ family: "IPv4", address: "10.0.0.7", internal: false }],
    };
    for (const value of ["", "0.0.0.0"]) {
      const ctx = setup({ networkInterface: value });
      await ctx.i.onReady();
      expect(ctx.ecp[0].options.bindIp, value).toBeUndefined();
      expect(ctx.ssdps[0].options.advertiseIp, value).toBe("192.168.1.20");
      // Multi-homed: joining only one interface makes the emulator invisible on
      // the other LAN.
      expect(ctx.ssdps[0].options.membershipInterfaces, value).toEqual(["192.168.1.20", "10.0.0.7"]);
    }
  });

  it("adopts the pre-0.5.0 BIND field when no interface is configured", async () => {
    const ctx = setup({ networkInterface: undefined, BIND: "10.1.2.3" });
    await ctx.i.onReady();
    expect(ctx.ecp[0].options.bindIp).toBe("10.1.2.3");
  });

  it("stops with a hint when no routable address exists", async () => {
    osMock.interfaces = { lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }] };
    const ctx = setup({ networkInterface: "" });
    await ctx.i.onReady();
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("No routable IPv4 address"));
    expect(ctx.ecp).toHaveLength(0);
  });
});

describe("Fakeroku onReady — discovery is an aid, not a precondition", () => {
  it("a failing SSDP start leaves the adapter usable and announces nothing", async () => {
    const ctx = setup({}, { ssdpStartFails: true });
    await ctx.i.onReady();

    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("SSDP discovery unavailable"));
    // ECP is what makes the adapter controllable — already-paired remotes work.
    expect(ctx.i.states.get("info.connection")).toEqual({ val: true, ack: true });
    expect(ctx.ssdps[0].announce).not.toHaveBeenCalled();
    expect(ctx.i.ssdp).toBeUndefined();
  });

  it("closes a responder whose start failed, so a late bind cannot outlive the dropped reference", async () => {
    const ctx = setup({}, { ssdpStartFails: true });
    await ctx.i.onReady();
    // A bind that only timed out can still complete later; without stop() that
    // socket keeps answering searches and onUnload has no handle left to close it.
    expect(ctx.ssdps[0].stop).toHaveBeenCalledTimes(1);
  });

  it("a successful start announces immediately and arms the repeat", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    expect(ctx.ssdps[0].announce).toHaveBeenCalledTimes(1);
    const repeat = ctx.i.setInterval.mock.calls.at(-1);
    expect(repeat, "the NOTIFY repeat must be armed").toBeDefined();
    // Fire the interval the way the runtime would — it must announce again.
    (repeat![0] as () => void)();
    expect(ctx.ssdps[0].announce).toHaveBeenCalledTimes(2);
  });

  it("a runtime socket death stops announcing but keeps ECP alive", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.clearInterval.mockClear();

    ctx.i.onSsdpFatal();

    expect(ctx.i.clearInterval).toHaveBeenCalledTimes(1);
    expect(ctx.i.ssdp).toBeUndefined();
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("SSDP discovery stopped"));
    // info.connection reflects ECP readiness and must NOT drop here.
    expect(ctx.i.states.get("info.connection")).toEqual({ val: true, ack: true });
  });
});

describe("Fakeroku applyCommand", () => {
  async function ready(): Promise<Ctx> {
    const ctx = setup();
    await ctx.i.onReady();
    return ctx;
  }

  it("records every command, pulses a standard key and releases it", async () => {
    const ctx = await ready();
    ctx.i.setTimeout.mockClear();

    ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "Home" });

    expect(ctx.i.states.get("Wohnzimmer.command")).toEqual({ val: "Home", ack: true });
    expect(ctx.i.states.get("Wohnzimmer.commandType")).toEqual({ val: "keypress", ack: true });
    expect(ctx.i.states.get("Wohnzimmer.keys.Home")).toEqual({ val: true, ack: true });
    // The pulse must clear itself — a key left true is a stuck button in the UI.
    const release = ctx.i.setTimeout.mock.calls.at(-1)!;
    (release[0] as () => void)();
    expect(ctx.i.states.get("Wohnzimmer.keys.Home")).toEqual({ val: false, ack: true });
  });

  it("drops a flood: past 25 commands in a second the rest are ignored, with one warning a minute", async () => {
    const ctx = await ready();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      ctx.i.setState.mockClear();
      const commandWrites = (): number => ctx.i.setState.mock.calls.filter(c => c[0] === "Wohnzimmer.command").length;
      for (let i = 0; i < 40; i++) {
        ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "Home" });
      }
      // Every accepted press is three writes plus one; a device sending a thousand a
      // second would turn the adapter into a write flood against the whole host.
      expect(commandWrites()).toBe(25);
      expect(ctx.i.log.warn).toHaveBeenCalledTimes(1);
      expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("more than 25 commands per second"));

      // Still flooding 30 s later: the budget has refilled, the warning has not repeated.
      clock.mockReturnValue(1_030_000);
      for (let i = 0; i < 40; i++) {
        ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "Home" });
      }
      expect(commandWrites()).toBe(50);
      expect(ctx.i.log.warn).toHaveBeenCalledTimes(1);

      // A minute after the first warning the log may say it again.
      clock.mockReturnValue(1_061_000);
      for (let i = 0; i < 40; i++) {
        ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "Home" });
      }
      expect(ctx.i.log.warn).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("rates each emulated Roku on its own — one flooding remote does not mute the other device", async () => {
    const ctx = setup({
      devices: [
        { name: "Wohnzimmer", port: 8060, type: "player" },
        { name: "Kueche", port: 8061, type: "player" },
      ],
    });
    await ctx.i.onReady();
    const clock = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    try {
      for (let i = 0; i < 40; i++) {
        ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "Home" });
      }
      ctx.i.applyCommand("Kueche", { type: "keypress", key: "Home" });
      expect(ctx.i.states.get("Kueche.command")).toEqual({ val: "Home", ack: true });
    } finally {
      clock.mockRestore();
    }
  });

  it("forgets a pulse timer once it has fired — the teardown list must not grow per keypress", async () => {
    const ctx = await ready();
    ctx.i.setTimeout.mockClear();
    ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "Home" });
    expect(ctx.i.pulseTimers.size).toBe(1);
    (ctx.i.setTimeout.mock.calls.at(-1)![0] as () => void)();
    // Every keypress adds one entry; without the removal a busy remote grows the
    // set for the lifetime of the instance.
    expect(ctx.i.pulseTimers.size).toBe(0);
  });

  it("forgets a watchdog once it has fired", async () => {
    const ctx = await ready();
    ctx.i.setTimeout.mockClear();
    ctx.i.applyCommand("Wohnzimmer", { type: "keydown", key: "Select" });
    expect(ctx.i.holdTimers.size).toBe(1);
    (ctx.i.setTimeout.mock.calls.at(-1)![0] as () => void)();
    expect(ctx.i.holdTimers.size).toBe(0);
  });

  it("a pulse is far shorter than the hold watchdog — a keypress must not look like a held key", async () => {
    const ctx = await ready();
    ctx.i.setTimeout.mockClear();
    ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "Home" });
    const pulseMs = ctx.i.setTimeout.mock.calls.at(-1)![1] as number;
    ctx.i.applyCommand("Wohnzimmer", { type: "keydown", key: "Select" });
    const holdMs = ctx.i.setTimeout.mock.calls.at(-1)![1] as number;
    // The two constants are easy to swap; a 30 s "pulse" would read as a stuck key.
    expect(pulseMs).toBeLessThan(1000);
    expect(holdMs).toBeGreaterThan(pulseMs * 10);
  });

  it("holds a key between keydown and keyup, and arms no watchdog on release", async () => {
    const ctx = await ready();
    ctx.i.applyCommand("Wohnzimmer", { type: "keydown", key: "Select" });
    expect(ctx.i.states.get("Wohnzimmer.keys.Select")).toEqual({ val: true, ack: true });

    ctx.i.setTimeout.mockClear();
    ctx.i.applyCommand("Wohnzimmer", { type: "keyup", key: "Select" });
    expect(ctx.i.states.get("Wohnzimmer.keys.Select")).toEqual({ val: false, ack: true });
    // The watchdog exists to release a stuck key. Arming one on the RELEASE
    // leaves a timer per keyup running for its full window — pure leakage, and
    // on unload one clearTimeout per stray press.
    expect(ctx.i.setTimeout, "no watchdog for a release").not.toHaveBeenCalled();
  });

  it("a lost keyup cannot pin a key true forever", async () => {
    const ctx = await ready();
    ctx.i.setTimeout.mockClear();
    ctx.i.applyCommand("Wohnzimmer", { type: "keydown", key: "Select" });

    // The controller disconnects mid-press: the watchdog releases the key.
    const watchdog = ctx.i.setTimeout.mock.calls.at(-1)!;
    (watchdog[0] as () => void)();
    expect(ctx.i.states.get("Wohnzimmer.keys.Select")).toEqual({ val: false, ack: true });
  });

  it("a repeated keydown re-arms the watchdog instead of leaking a timer", async () => {
    const ctx = await ready();
    ctx.i.clearTimeout.mockClear();
    ctx.i.applyCommand("Wohnzimmer", { type: "keydown", key: "Select" });
    ctx.i.applyCommand("Wohnzimmer", { type: "keydown", key: "Select" });
    expect(ctx.i.clearTimeout, "the pending watchdog is cleared first").toHaveBeenCalledTimes(1);
  });

  it("a key this device type does not carry lands in command only", async () => {
    const ctx = await ready(); // player
    ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "PowerOff" });
    expect(ctx.i.states.get("Wohnzimmer.command")).toEqual({ val: "PowerOff", ack: true });
    // Writing a state that was never created produces a js-controller warning
    // for every press — the key set is what prevents it.
    expect(ctx.i.states.has("Wohnzimmer.keys.PowerOff")).toBe(false);

    // Same for the hold path: a TV key held on a player must not create one
    // either, and must not arm a watchdog for a state that does not exist.
    ctx.i.setTimeout.mockClear();
    ctx.i.applyCommand("Wohnzimmer", { type: "keydown", key: "PowerOff" });
    expect(ctx.i.states.has("Wohnzimmer.keys.PowerOff")).toBe(false);
    expect(ctx.i.setTimeout).not.toHaveBeenCalled();
  });

  it("a rejected state write is traced, not thrown — a remote can still press keys while the database closes", async () => {
    const ctx = await ready();
    (ctx.i as unknown as { setState: unknown }).setState = vi.fn(() => {
      return Promise.reject(new Error("States database not connected"));
    });
    expect(() => ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "Home" })).not.toThrow();
    // Let the rejections settle — an unhandled one fails the run (and kills the adapter).
    await new Promise(resolve => setImmediate(resolve));
    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("State write Wohnzimmer.command failed"));
  });

  it("keyboard input and app launches never create per-character objects", async () => {
    const ctx = await ready();
    ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "Lit_a" });
    ctx.i.applyCommand("Wohnzimmer", { type: "launch", appId: "12" });
    expect(ctx.i.states.get("Wohnzimmer.command")).toEqual({ val: "launch:12", ack: true });
    expect([...ctx.i.states.keys()].some(k => k.includes("Lit_"))).toBe(false);
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
    osMock.interfaces = { lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }] };
    const ctx = setup({ networkInterface: "", devices: [] });
    ctx.i.objects.set("Wohnzimmer", { type: "device" });

    await ctx.i.onReady();

    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("No routable IPv4 address"));
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

describe("Fakeroku startWithTimeout", () => {
  it("rejects when the start does not settle in time", async () => {
    const ctx = setup();
    // The stub's setTimeout does not fire on its own — invoke the callback the
    // way the runtime would once the deadline passes.
    const never = new Promise<void>(() => {});
    const bounded = ctx.i.startWithTimeout(never, 500);
    const armed = ctx.i.setTimeout.mock.calls.at(-1)!;
    (armed[0] as () => void)();
    await expect(bounded).rejects.toThrow(/timed out after 500/);
  });

  it("clears the deadline when the start succeeds", async () => {
    const ctx = setup();
    ctx.i.clearTimeout.mockClear();
    await ctx.i.startWithTimeout(Promise.resolve(), 500);
    expect(ctx.i.clearTimeout).toHaveBeenCalledTimes(1);
  });
});

describe("Fakeroku onUnload", () => {
  it("stops every server, clears every timer and always calls back", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "Home" }); // arms a pulse timer
    ctx.i.applyCommand("Wohnzimmer", { type: "keydown", key: "Select" }); // arms a watchdog
    ctx.i.clearTimeout.mockClear();
    ctx.i.clearInterval.mockClear();

    const callback = vi.fn();
    await new Promise<void>(resolve => ctx.i.onUnload(() => (callback(), resolve())));

    expect(callback).toHaveBeenCalledTimes(1);
    expect(ctx.ssdps[0].stop).toHaveBeenCalledTimes(1);
    expect(ctx.ecp[0].stop).toHaveBeenCalledTimes(1);
    expect(ctx.i.clearInterval).toHaveBeenCalledTimes(1); // the NOTIFY repeat
    expect(ctx.i.clearTimeout.mock.calls.length).toBeGreaterThanOrEqual(2); // pulse + watchdog
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
  });

  it("reports done only after the last write has landed", async () => {
    const ctx = setup();
    await ctx.i.onReady();

    // The write has to settle a turn LATER than the call, or this test would pass
    // with the callback fired first — a write that resolves synchronously proves
    // nothing about ordering.
    const order: string[] = [];
    const store = ctx.i.states;
    (ctx.i as unknown as { setState: unknown }).setState = vi.fn(
      async (id: string, state: { val?: unknown; ack?: boolean }) =>
        new Promise<void>(resolve =>
          globalThis.setTimeout(() => {
            order.push(`write:${id}`);
            store.set(id, { val: state?.val, ack: state?.ack === true });
            resolve();
          }, 0),
        ),
    );

    await new Promise<void>(resolve => ctx.i.onUnload(() => (order.push("callback"), resolve())));

    // Fire-and-forget plus an immediate callback loses the write: the process is
    // gone before it reaches the database, and the instance keeps showing
    // "connected" while the adapter is off.
    expect(order).toEqual(["write:info.connection", "callback"]);
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
  });

  it("still reports done when the last write is rejected", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    (ctx.i as unknown as { setState: unknown }).setState = vi.fn(() => {
      return Promise.reject(new Error("database gone"));
    });

    // A teardown that never calls back is killed by js-controller — a failing
    // write must not cost the callback. And the rejection has to be HANDLED:
    // an unhandled one turns an orderly stop into a crash, so the debug trace is
    // the proof that something caught it.
    const callback = vi.fn();
    await new Promise<void>(resolve => ctx.i.onUnload(() => (callback(), resolve())));
    expect(callback).toHaveBeenCalledTimes(1);
    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("Final connection write failed"));
  });

  it("still calls back when a teardown step throws", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.ecp[0].stop.mockImplementation(() => {
      throw new Error("socket already gone");
    });

    const callback = vi.fn();
    // A throwing teardown that skips the callback is a hard kill by js-controller.
    expect(() => ctx.i.onUnload(callback)).not.toThrow();
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe("Fakeroku collaborator wiring", () => {
  it("builds the real collaborators when nothing replaces the seams", () => {
    // The seams exist only for these tests. If they ever pointed at the wrong
    // class, every test here would still pass while production started nothing.
    const i = internalOf(new Fakeroku());
    const make = i.makeEcpServer as (o: unknown) => unknown;
    const makeSsdp = i.makeSsdpResponder as (o: unknown) => unknown;
    expect(make({ device: { uuid: "a", port: 8060 } })).toBeInstanceOf(EcpHttpServer);
    expect(makeSsdp({ devices: [], membershipInterfaces: [] })).toBeInstanceOf(RokuSsdpResponder);
  });

  it("routes each ECP server's commands to ITS OWN device", async () => {
    const ctx = setup({
      devices: [
        { name: "Wohnzimmer", port: 8060, type: "player" },
        { name: "Kueche", port: 8061, type: "player" },
      ],
    });
    await ctx.i.onReady();
    const onCommand = ctx.ecp[1].options.onCommand as (c: CommandEvent) => void;
    onCommand({ type: "keypress", key: "Home" });
    // A shared or mis-captured deviceId here makes every remote control the first
    // Roku — the classic loop-variable capture bug, invisible with one device.
    expect(ctx.i.states.get("Kueche.command")).toEqual({ val: "Home", ack: true });
    expect(ctx.i.states.has("Wohnzimmer.command")).toBe(false);
  });

  it("hooks the responder's fatal callback to the announce shutdown", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.clearInterval.mockClear();
    const onFatal = ctx.ssdps[0].options.onFatalError as () => void;
    onFatal();
    // Without this wiring the announce interval keeps firing into a dead socket
    // for as long as the instance runs.
    expect(ctx.i.clearInterval).toHaveBeenCalledTimes(1);
    expect(ctx.i.ssdp).toBeUndefined();
  });

  it("hooks each ECP server's fatal callback to the connection status", async () => {
    // A server that dies after a good start leaves a device answering nothing. Without
    // this wiring info.connection stays true — a green instance in front of a Roku that
    // is gone, which nobody would notice. The SSDP responder has had the same callback
    // since 1.1.0; the ECP servers only logged.
    const ctx = setup({ devices: [{ name: "Wohnzimmer", port: 8060, type: "player" }] });
    await ctx.i.onReady();
    expect(ctx.i.states.get("info.connection")?.val).toBe(true);

    const onFatal = ctx.ecp[0].options.onFatalError as () => void;
    expect(onFatal, "the ECP server's fatal callback must be wired").toBeDefined();
    onFatal();

    expect(ctx.i.states.get("info.connection")?.val).toBe(false);
    expect(ctx.i.log.error).toHaveBeenCalledWith(expect.stringContaining('"Wohnzimmer" stopped answering'));
  });

  it("survives a failing status write when a device dies", async () => {
    // onEcpFatal runs from a socket event, outside any await. An unhandled rejection
    // there is an adapter crash (exit code 6) over a state write that failed because
    // the database is already going down — the very moment this path fires.
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.setState.mockRejectedValueOnce(new Error("states db closed"));

    const onFatal = ctx.ecp[0].options.onFatalError as () => void;
    expect(() => onFatal()).not.toThrow();
    await Promise.resolve();

    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("states db closed"));
  });

  it("a fatal report with no announce running does not touch the timer API", async () => {
    const ctx = setup({}, { ssdpStartFails: true });
    await ctx.i.onReady();
    ctx.i.clearInterval.mockClear();
    ctx.i.onSsdpFatal();
    // clearInterval(undefined) is a js-controller warning per call, not a no-op.
    expect(ctx.i.clearInterval).not.toHaveBeenCalled();
  });
});

describe("Fakeroku start-up robustness", () => {
  it("reports a failing start-up instead of dying on an unhandled rejection", async () => {
    const ctx = setup();
    (ctx.i as unknown as { getAdapterObjectsAsync: ReturnType<typeof vi.fn> }).getAdapterObjectsAsync.mockRejectedValue(
      new Error("objects db down"),
    );
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
    expect(ctx.i.log.warn).toHaveBeenCalledWith("No emulated Roku devices configured.");
    expect(ctx.i.states.get("info.connection")?.val).not.toBe(true);
  });

  it("keeps cleaning up when one stale object cannot be deleted", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.objects.set("Buero", { type: "device", common: { name: "Buero" }, native: {} });
    ctx.i.objects.set("Flur", { type: "device", common: { name: "Flur" }, native: {} });
    const del = (ctx.i as unknown as { delObjectAsync: ReturnType<typeof vi.fn> }).delObjectAsync;
    const real = del.getMockImplementation() as (id: string, o?: unknown) => Promise<void>;
    del.mockImplementation(async (id: string, o?: unknown) => {
      if (id.endsWith("Buero")) {
        throw new Error("locked");
      }
      return real(id, o);
    });
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
