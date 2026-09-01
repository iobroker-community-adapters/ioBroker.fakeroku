import { vi } from "vitest";

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
    public setState = vi.fn(async (id: string, state: unknown) => {
      const s = state as { val?: unknown; ack?: boolean };
      this.states.set(id.replace(`${this.namespace}.`, ""), { val: s?.val, ack: s?.ack === true });
    });
    public extendObject = vi.fn(async (id: string, obj: Record<string, unknown>) => {
      const key = id.replace(`${this.namespace}.`, "");
      this.objects.set(key, { ...(this.objects.get(key) ?? {}), ...obj });
    });
    public getAdapterObjectsAsync = vi.fn(async () => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of this.objects) {
        out[`${this.namespace}.${k}`] = v;
      }
      return out;
    });
    public delObjectAsync = vi.fn(async (id: string, opts?: { recursive?: boolean }) => {
      const key = id.replace(`${this.namespace}.`, "");
      for (const k of [...this.objects.keys()]) {
        if (k === key || (opts?.recursive && k.startsWith(`${key}.`))) {
          this.objects.delete(k);
        }
      }
    });
    public setInterval = vi.fn(() => ({ kind: "interval" }) as unknown);
    public clearInterval = vi.fn();
    public setTimeout = vi.fn((_cb: () => void, _ms: number) => ({ kind: "timeout" }) as unknown);
    public clearTimeout = vi.fn();
    constructor(_opts: unknown) {}
  }
  return { Adapter, I18n: { init: vi.fn(async () => {}) } };
});

/** os.networkInterfaces is swapped so the advertise-IP paths are deterministic. */
const osMock = vi.hoisted(() => ({ interfaces: null as Record<string, unknown[]> | null }));
vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof import("node:os")>();
  const networkInterfaces = (): unknown => osMock.interfaces ?? actual.networkInterfaces();
  return { ...actual, default: { ...actual, networkInterfaces }, networkInterfaces };
});

import { I18n } from "@iobroker/adapter-core";
import { join } from "node:path";
import { Fakeroku } from "./main";
import type { CommandEvent } from "./ecp/ecp-command";
import { EcpHttpServer } from "./ecp/ecp-http-server";
import { RokuSsdpResponder } from "./discovery/ssdp-responder";

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

/** Typed access to the private members the orchestration tests drive. */
function internalOf(adapter: Fakeroku): {
  onReady(): Promise<void>;
  onUnload(cb: () => void): void;
  applyCommand(deviceId: string, cmd: CommandEvent): void;
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
      start: vi.fn(async () => {
        if (opts.failEcpPort === port) {
          throw new Error(`EADDRINUSE ${port}`);
        }
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
      start: vi.fn(async () => {
        if (opts.ssdpStartFails) {
          throw new Error("port 1900 busy");
        }
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

  it("names the keys channel like the other objects", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    expect(ctx.i.objects.get("Wohnzimmer.keys")).toMatchObject({ common: { name: "Remote keys" } });
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
    (ctx.i as unknown as { setState: unknown }).setState = vi.fn(async () => {
      throw new Error("States database not connected");
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
    (ctx.i as unknown as { setState: unknown }).setState = vi.fn(async () => {
      throw new Error("database gone");
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
