// Guard of F-11 (taken over 2026-10-02 23:52): every emulated Roku is a player or a TV; only the TV has the keys for
// volume, power, channel and input — a player 16 keys, a TV 16 + 15. Sealed in the register — a change goes through
// the Werkbank.
import { describe, expect, it } from "vitest";
import { keysForType } from "../ecp/state-model";

describe("F-11 — player 16 keys, TV those 16 plus 15", () => {
  const player = keysForType("player");
  const tv = keysForType("tv");

  it("gives a player 16 keys and a TV 31", () => {
    expect(player).toHaveLength(16);
    expect(tv).toHaveLength(31);
  });

  it("gives a TV every player key", () => {
    for (const key of player) {
      expect(tv, key).toContain(key);
    }
  });

  it("keeps volume, power, channel and input to the TV", () => {
    const tvOnly = tv.filter(key => !player.includes(key));
    expect(tvOnly).toHaveLength(15);
    for (const key of tvOnly) {
      expect(key, key).toMatch(/^(Volume|Power|Sleep|Channel|Input)/);
    }
  });
});
