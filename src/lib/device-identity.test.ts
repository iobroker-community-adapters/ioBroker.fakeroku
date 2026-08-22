import { deriveUuid } from "./device-identity";

describe("deriveUuid", () => {
  it("is stable for the same name (no A1-style drift across restarts)", () => {
    expect(deriveUuid("ioBroker")).toBe(deriveUuid("ioBroker"));
  });
  it("differs for different names", () => {
    expect(deriveUuid("Living Room")).not.toBe(deriveUuid("Bedroom"));
  });
  it("stays byte-identical across releases (a changed identity re-pairs the remote)", () => {
    // The identity IS the pairing: a Harmony that learned this Roku remembers
    // exactly this serial/USN. Changing how it is derived silently unpairs every
    // installed remote — so the value is pinned, not just its shape.
    expect(deriveUuid("Wohnzimmer")).toBe("696346e04d540f04b4540905f3bd8f5c");
    expect(deriveUuid("Roku")).toBe("345a9accaa68ee17ddae11911ea49c10");
  });

  it("has the Roku serial shape (32-char hex)", () => {
    expect(deriveUuid("ioBroker")).toMatch(/^[0-9a-f]{32}$/);
  });
});
