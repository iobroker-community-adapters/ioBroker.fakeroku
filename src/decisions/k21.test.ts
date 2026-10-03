// Guard of K21 (krobi 2026-10-03, taken over 2026-10-02 23:52 with F-01): 25 commands per second and emulated Roku, at
// most one warning per minute, naming the device. Sealed in the register — a change goes through the Werkbank.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandHandler, type CommandTarget } from "../command-handler";

/**
 * A handler with a recording host.
 *
 * @returns the handler and the warnings it wrote
 */
function host(): { handler: CommandHandler; warnings: string[] } {
  const warnings: string[] = [];
  const handler = new CommandHandler({
    writeState: () => {},
    setTimeout: () => ({}) as unknown as ioBroker.Timeout,
    clearTimeout: () => {},
    warn: message => {
      warnings.push(message);
    },
  });
  return { handler, warnings };
}

const wohnzimmer: CommandTarget = { id: "Wohnzimmer", name: "Wohnzimmer", keys: new Set<string>() };

/**
 * Send commands at the current instant.
 *
 * @param h the handler
 * @param n how many
 * @returns how many were applied
 */
function burst(h: ReturnType<typeof host>, n: number): number {
  return Array.from({ length: n }, () => h.handler.apply(wohnzimmer, { type: "keypress", key: "Home" })).filter(Boolean)
    .length;
}

describe("K21 — 25 commands per second, at most one warning a minute with the device name", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies exactly 25 commands in one instant", () => {
    expect(burst(host(), 40)).toBe(25);
  });

  it("lets 25 more through one second later", () => {
    const h = host();
    burst(h, 40);
    vi.advanceTimersByTime(1000);
    expect(burst(h, 40)).toBe(25);
  });

  it("warns once a minute, naming the device", () => {
    const h = host();
    burst(h, 40);
    vi.advanceTimersByTime(30_000);
    burst(h, 40);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('"Wohnzimmer"');
    expect(h.warnings[0]).toContain("25");
    vi.advanceTimersByTime(30_000);
    burst(h, 40);
    expect(h.warnings).toHaveLength(2);
  });
});
