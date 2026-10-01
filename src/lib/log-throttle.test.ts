import { describe, expect, it } from "vitest";
import { LogThrottle } from "./log-throttle";

describe("LogThrottle", () => {
  it("lets the first line of a kind through and holds the next one for the interval", () => {
    const t = new LogThrottle(60_000);
    expect(t.due("drop", 1_000)).toBe(true);
    expect(t.due("drop", 60_999)).toBe(false);
    expect(t.due("drop", 61_000)).toBe(true);
  });

  it("throttles every kind on its own", () => {
    const t = new LogThrottle(60_000);
    expect(t.due("a", 0)).toBe(true);
    expect(t.due("b", 0)).toBe(true);
    expect(t.due("a", 1)).toBe(false);
  });

  it("lets the first line through even at clock zero", () => {
    expect(new LogThrottle(60_000).due("x", 0)).toBe(true);
  });
});
