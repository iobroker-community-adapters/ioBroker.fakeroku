// Guard of F-02 (krobi 2026-09-01 23:10, "1. würde ich sagen lassen"): two presses of the same key within 50 ms stay as
// they are — the second press does not re-arm or lengthen the pulse; the first release still ends it. Sealed in the
// register — a change goes through the Werkbank.
import { describe, expect, it } from "vitest";
import { CommandHandler, KEY_PULSE_MS, type CommandTarget } from "../command-handler";

interface Timer {
  cb: () => void;
  ms: number;
}

describe("F-02 — a second press within 50 ms does not re-arm the pulse", () => {
  it("the first press's release ends the key, although the second press came 20 ms later", () => {
    const writes: [string, unknown][] = [];
    const timers: Timer[] = [];
    const handler = new CommandHandler({
      writeState: (id, val) => {
        writes.push([id, val]);
      },
      setTimeout: (cb, ms) => {
        const t = { cb, ms };
        timers.push(t);
        return t as unknown as ioBroker.Timeout;
      },
      clearTimeout: () => {},
      warn: () => {},
    });
    const roku: CommandTarget = { id: "A", name: "A", keys: new Set(["Home"]) };

    handler.apply(roku, { type: "keypress", key: "Home" });
    handler.apply(roku, { type: "keypress", key: "Home" });
    expect(KEY_PULSE_MS).toBe(50);
    expect(timers.map(t => t.ms)).toEqual([50, 50]);

    timers[0].cb();

    expect(writes.at(-1)).toEqual(["A.keys.Home", false]);
  });
});
