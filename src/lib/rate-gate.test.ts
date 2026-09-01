import { RateGate } from "./rate-gate";

describe("RateGate", () => {
  it("lets a full second's worth through at once and refuses the next one", () => {
    const gate = new RateGate(25, 1000);
    for (let i = 0; i < 25; i++) {
      expect(gate.allow(1000), `command ${i + 1}`).toBe(true);
    }
    // The 26th press in the same instant is the flood, not a remote.
    expect(gate.allow(1000)).toBe(false);
  });

  it("refills with time, proportionally", () => {
    const gate = new RateGate(25, 1000);
    for (let i = 0; i < 25; i++) {
      gate.allow(1000);
    }
    expect(gate.allow(1000)).toBe(false);
    // 40 ms at 25/s is exactly one token.
    expect(gate.allow(1040)).toBe(true);
    expect(gate.allow(1040)).toBe(false);
    // A full second later the whole budget is back.
    expect(Array.from({ length: 25 }, () => gate.allow(2040)).every(Boolean)).toBe(true);
  });

  it("never stores more than one second of budget", () => {
    const gate = new RateGate(25, 1000);
    // Idle for an hour must not buy a 90 000-press burst afterwards.
    let passed = 0;
    for (let i = 0; i < 100; i++) {
      if (gate.allow(3_601_000)) {
        passed++;
      }
    }
    expect(passed).toBe(25);
  });

  it("does not go into debt when the clock jumps backwards", () => {
    const gate = new RateGate(25, 5000);
    for (let i = 0; i < 25; i++) {
      gate.allow(5000);
    }
    expect(gate.allow(4000)).toBe(false);
    // Counting the jump as negative time would leave a debt of a whole second: the
    // next legitimate press 40 ms later must pass, not wait for the debt to clear.
    expect(gate.allow(4040)).toBe(true);
  });
});
