import {
  CommandHandler,
  HOLD_MAX_MS,
  KEY_PULSE_MS,
  MAX_COMMANDS_PER_SECOND,
  type CommandTarget,
} from "./command-handler";

/** A host that records every write and keeps the timers in hand, so a test fires them itself. */
function host(): {
  writes: [string, string | boolean][];
  timers: { cb: () => void; ms: number; handle: { seq: number } }[];
  cleared: unknown[];
  warnings: string[];
  handler: CommandHandler;
} {
  const writes: [string, string | boolean][] = [];
  const timers: { cb: () => void; ms: number; handle: { seq: number } }[] = [];
  const cleared: unknown[] = [];
  const warnings: string[] = [];
  let seq = 0;
  const handler = new CommandHandler({
    writeState: (id, val) => writes.push([id, val]),
    setTimeout: (cb, ms) => {
      const handle = { seq: ++seq };
      timers.push({ cb, ms, handle });
      return handle as unknown as ioBroker.Timeout;
    },
    clearTimeout: t => cleared.push(t),
    warn: m => warnings.push(m),
  });
  return { writes, timers, cleared, warnings, handler };
}

const player: CommandTarget = { id: "Wohnzimmer", name: "Wohnzimmer", keys: new Set(["Home", "Select"]) };

describe("CommandHandler", () => {
  it("records a keypress and pulses the key true, then false after the pulse", () => {
    const h = host();
    expect(h.handler.apply(player, { type: "keypress", key: "Home" })).toBe(true);
    expect(h.writes).toEqual([
      ["Wohnzimmer.command", "Home"],
      ["Wohnzimmer.keys.Home", true],
    ]);
    expect(h.timers[0].ms).toBe(KEY_PULSE_MS);
    h.timers[0].cb();
    expect(h.writes.at(-1)).toEqual(["Wohnzimmer.keys.Home", false]);
  });

  it("writes only command for a key the device does not carry", () => {
    const h = host();
    h.handler.apply(player, { type: "keypress", key: "VolumeUp" });
    expect(h.writes.map(w => w[0])).toEqual(["Wohnzimmer.command"]);
    expect(h.timers).toHaveLength(0);
  });

  it("holds a key on keydown, arms the watchdog, and releases on keyup", () => {
    const h = host();
    h.handler.apply(player, { type: "keydown", key: "Select" });
    expect(h.writes.at(-1)).toEqual(["Wohnzimmer.keys.Select", true]);
    expect(h.timers[0].ms).toBe(HOLD_MAX_MS);
    h.handler.apply(player, { type: "keyup", key: "Select" });
    expect(h.writes.at(-1)).toEqual(["Wohnzimmer.keys.Select", false]);
    expect(h.cleared).toEqual([h.timers[0].handle]);
  });

  it("the watchdog releases a key whose keyup was lost", () => {
    const h = host();
    h.handler.apply(player, { type: "keydown", key: "Select" });
    h.timers[0].cb();
    expect(h.writes.at(-1)).toEqual(["Wohnzimmer.keys.Select", false]);
  });

  it("drops the commands over the rate and warns once with the device name", () => {
    const h = host();
    const accepted = Array.from({ length: MAX_COMMANDS_PER_SECOND + 5 }, () =>
      h.handler.apply(player, { type: "keypress", key: "Home" }),
    ).filter(Boolean).length;
    expect(accepted).toBe(MAX_COMMANDS_PER_SECOND);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('"Wohnzimmer"');
  });

  it("never drops the release of a held key at the rate gate", () => {
    const h = host();
    h.handler.apply(player, { type: "keydown", key: "Select" });
    for (let i = 0; i < MAX_COMMANDS_PER_SECOND; i++) {
      h.handler.apply(player, { type: "keypress", key: "Home" });
    }
    expect(h.handler.apply(player, { type: "keyup", key: "Select" })).toBe(true);
    // A keyup for a key nobody holds still meets the gate.
    expect(h.handler.apply(player, { type: "keyup", key: "Home" })).toBe(false);
  });

  it("dispose disarms every pulse and watchdog timer", () => {
    const h = host();
    h.handler.apply(player, { type: "keypress", key: "Home" });
    h.handler.apply(player, { type: "keydown", key: "Select" });
    h.handler.dispose();
    expect(h.cleared).toEqual(expect.arrayContaining(h.timers.map(t => t.handle)));
  });
});
