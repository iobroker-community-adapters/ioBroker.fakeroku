import { vi } from "vitest";
import type * as OsModule from "node:os";

/**
 * Orchestration tests of the adapter — Remote commands through the adapter: pulse, hold, watchdog and the rate gate, as wired in onReady.
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

import { setup, settle, type Ctx, resetHarness, lastTimer, twoPlayers } from "../test/helpers/fakeroku-harness";

afterEach(resetHarness);

describe("Fakeroku applyCommand", () => {
  async function ready(): Promise<Ctx> {
    const ctx = setup();
    await ctx.i.onReady();
    return ctx;
  }

  it("does nothing for a device it does not run", async () => {
    const ctx = await ready();
    const before = ctx.i.written.length;
    expect(ctx.i.applyCommand("Nowhere", { type: "keypress", key: "Home" })).toBe(false);
    expect(ctx.i.written).toHaveLength(before);
  });

  it("records every command, pulses a standard key and releases it", async () => {
    const ctx = await ready();
    ctx.i.setTimeout.mockClear();

    ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "Home" });

    expect(ctx.i.states.get("Wohnzimmer.command")).toEqual({ val: "Home", ack: true });
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
    const ctx = setup(twoPlayers());
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
    expect(ctx.i.commands.pulseTimers.size).toBe(1);
    lastTimer(ctx)();
    // Every keypress adds one entry; without the removal a busy remote grows the
    // set for the lifetime of the instance.
    expect(ctx.i.commands.pulseTimers.size).toBe(0);
  });

  it("forgets a watchdog once it has fired", async () => {
    const ctx = await ready();
    ctx.i.setTimeout.mockClear();
    ctx.i.applyCommand("Wohnzimmer", { type: "keydown", key: "Select" });
    expect(ctx.i.commands.holdTimers.size).toBe(1);
    lastTimer(ctx)();
    expect(ctx.i.commands.holdTimers.size).toBe(0);
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
    const first = ctx.i.setTimeout.mock.results.at(-1)!.value as unknown;
    ctx.i.applyCommand("Wohnzimmer", { type: "keydown", key: "Select" });
    expect(ctx.i.clearTimeout, "the pending watchdog is cleared first").toHaveBeenCalledWith(first);
    expect(ctx.i.clearTimeout).toHaveBeenCalledTimes(1);
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
    ctx.i.setState.mockImplementation(() => Promise.reject(new Error("States database not connected")));
    expect(() => ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "Home" })).not.toThrow();
    // Let the rejections settle — an unhandled one fails the run (and kills the adapter).
    await settle();
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

describe("Fakeroku — a key release is never dropped", () => {
  it("lets a keyup through even while the flood gate is closed", async () => {
    // The gate protects the states database from a flood. Dropping a keypress costs one
    // event; dropping the RELEASE leaves the key true until the 30 s watchdog — the
    // protection would be the thing that falsifies the tree.
    const ctx = setup();
    await ctx.i.onReady();
    // A frozen clock: the gate refills continuously, and a loop that stalls 40 ms (GC, a busy
    // CI runner, coverage instrumentation) would otherwise let a 26th command through.
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    ctx.i.applyCommand("Wohnzimmer", { type: "keydown", key: "Home" });
    for (let n = 0; n < 60; n++) {
      ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "Select" });
    }
    expect(ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "Select" })).toBe(false);

    expect(ctx.i.applyCommand("Wohnzimmer", { type: "keyup", key: "Home" })).toBe(true);
    expect(ctx.i.states.get("Wohnzimmer.keys.Home")).toEqual({ val: false, ack: true });
  });

  it("a keyup for a key nobody holds is rate-limited like any other command", async () => {
    // The exemption exists for a key that is actually HELD. Asking only what the request
    // looks like would let a remote sending nothing but keyup bypass the gate entirely —
    // three writes each and, because the server logs only what was applied, a log line per
    // request. Dropping them falsifies nothing: the key was never true.
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.setState.mockClear();
    const commandWrites = (): number => ctx.i.setState.mock.calls.filter(c => c[0] === "Wohnzimmer.command").length;
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    for (let n = 0; n < 60; n++) {
      ctx.i.applyCommand("Wohnzimmer", { type: "keyup", key: "Home" });
    }

    expect(commandWrites()).toBe(25);
    expect(ctx.i.applyCommand("Wohnzimmer", { type: "keyup", key: "Home" })).toBe(false);
    expect(ctx.i.states.get("Wohnzimmer.keys.Home")).toEqual({ val: false, ack: true });
  });

  it("a keydown inside the pulse window keeps the key held when the pulse expires", async () => {
    // ECP defines a keypress as pressing down AND releasing — a finished act, so a keydown
    // arriving before the 50 ms pulse expires starts a new one and owns the key. The old
    // pulse writing its release would end a hold that is still going on and leave the
    // watchdog armed for a key that already reads false.
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.setTimeout.mockClear();

    ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "Home" });
    const pulse = lastTimer(ctx);
    ctx.i.applyCommand("Wohnzimmer", { type: "keydown", key: "Home" });

    pulse();

    expect(ctx.i.states.get("Wohnzimmer.keys.Home")).toEqual({ val: true, ack: true });
    expect(ctx.i.commands.holdTimers.has("Wohnzimmer.keys.Home")).toBe(true);
    // The keyup still ends it — the hold is intact, not orphaned.
    ctx.i.applyCommand("Wohnzimmer", { type: "keyup", key: "Home" });
    expect(ctx.i.states.get("Wohnzimmer.keys.Home")).toEqual({ val: false, ack: true });
  });

  it("two overlapping pulses both still release — that overlap is deliberate", async () => {
    // The fix above must not turn into "one pulse timer per key": two keypresses 10 ms
    // apart are a real remote repeating itself, and both releasing is the behaviour this
    // adapter chose to keep.
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.setTimeout.mockClear();

    ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "Home" });
    const first = lastTimer(ctx);
    ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "Home" });
    const second = lastTimer(ctx);

    first();
    expect(ctx.i.states.get("Wohnzimmer.keys.Home")).toEqual({ val: false, ack: true });
    second();
    expect(ctx.i.states.get("Wohnzimmer.keys.Home")).toEqual({ val: false, ack: true });
  });

  it("a keypress on a HELD key disarms the hold watchdog it replaces", async () => {
    // Otherwise the watchdog fires 30 s later and writes a release for a key that the
    // pulse already released — a phantom edge for every rule watching that key.
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.applyCommand("Wohnzimmer", { type: "keydown", key: "Home" });
    expect(ctx.i.commands.holdTimers.has("Wohnzimmer.keys.Home")).toBe(true);
    const watchdog = ctx.i.setTimeout.mock.results.at(-1)!.value as unknown;
    ctx.i.clearTimeout.mockClear();

    ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "Home" });

    expect(ctx.i.commands.holdTimers.has("Wohnzimmer.keys.Home")).toBe(false);
    expect(ctx.i.clearTimeout).toHaveBeenCalledWith(watchdog);
  });
});

describe("Fakeroku — log lines name the device the way the user named it", () => {
  it("the flood warning carries the device name, not its object id", async () => {
    const ctx = setup({ devices: [{ name: "Wohn zimmer", port: 8060, type: "player" }] });
    await ctx.i.onReady();
    // Frozen clock: the bucket must not refill while the loop runs.
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    for (let n = 0; n < 30; n++) {
      ctx.i.applyCommand("Wohn_zimmer", { type: "keypress", key: "Home" });
    }
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining('"Wohn zimmer" receives more than 25'));
  });
});
