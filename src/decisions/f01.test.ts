// Guard of F-01 (krobi 2026-09-01 23:10 / 23:20): every emulated Roku has a rate limit for commands; what goes beyond
// it is dropped. Sealed in the register — a change goes through the Werkbank, never through this file.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandHandler, type CommandTarget } from "../command-handler";

/**
 * A handler with a recording host — no adapter, no clock of its own.
 *
 * @returns the handler and the writes it made
 */
function host(): { handler: CommandHandler; writes: [string, unknown][] } {
  const writes: [string, unknown][] = [];
  const handler = new CommandHandler({
    writeState: (id, val) => {
      writes.push([id, val]);
    },
    setTimeout: () => ({}) as unknown as ioBroker.Timeout,
    clearTimeout: () => {},
    warn: () => {},
  });
  return { handler, writes };
}

const roku = (id: string): CommandTarget => ({ id, name: id, keys: new Set<string>() });

describe("F-01 — a rate limit per emulated Roku, the excess dropped", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops the commands beyond the limit and writes nothing for them", () => {
    const h = host();
    const a = roku("A");
    const applied = Array.from({ length: 200 }, () => h.handler.apply(a, { type: "keypress", key: "Home" }));
    const accepted = applied.filter(Boolean).length;
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(200);
    expect(h.writes.filter(([id]) => id === "A.command")).toHaveLength(accepted);
  });

  it("limits each emulated Roku on its own", () => {
    const h = host();
    for (let n = 0; n < 200; n++) {
      h.handler.apply(roku("A"), { type: "keypress", key: "Home" });
    }
    expect(h.handler.apply(roku("A"), { type: "keypress", key: "Home" })).toBe(false);
    expect(h.handler.apply(roku("B"), { type: "keypress", key: "Home" })).toBe(true);
  });
});
