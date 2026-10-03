// Guard of K9 (krobi 2026-10-02 23:52, taken over): a held key has a 30-second watchdog, and the release of a held key
// never runs into the rate limit. Sealed in the register — a change goes through the Werkbank.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandHandler, HOLD_MAX_MS, type CommandTarget } from "../command-handler";

interface Timer {
  cb: () => void;
  ms: number;
}

/**
 * A handler with a recording host and manual timers.
 *
 * @returns the handler, its writes and its timers
 */
function host(): { handler: CommandHandler; writes: [string, unknown][]; timers: Timer[] } {
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
  return { handler, writes, timers };
}

const roku: CommandTarget = { id: "A", name: "A", keys: new Set(["Select"]) };

describe("K9 — 30-second watchdog for a held key; its release passes the rate limit", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("releases a key held without a keyup after 30 seconds", () => {
    const h = host();
    h.handler.apply(roku, { type: "keydown", key: "Select" });
    expect(HOLD_MAX_MS).toBe(30_000);
    const watchdog = h.timers.find(t => t.ms === 30_000);
    expect(watchdog).toBeDefined();
    watchdog!.cb();
    expect(h.writes.at(-1)).toEqual(["A.keys.Select", false]);
  });

  it("applies the release of a held key although the rate limit is used up", () => {
    const h = host();
    h.handler.apply(roku, { type: "keydown", key: "Select" });
    for (let n = 0; n < 200; n++) {
      h.handler.apply(roku, { type: "keypress", key: "Home" });
    }
    expect(h.handler.apply(roku, { type: "keypress", key: "Home" })).toBe(false);

    expect(h.handler.apply(roku, { type: "keyup", key: "Select" })).toBe(true);
    expect(h.writes.at(-1)).toEqual(["A.keys.Select", false]);
  });
});
