import { deriveUuid } from "./device-identity";

describe("deriveUuid", () => {
  it("is stable for the same name (no A1-style drift across restarts)", () => {
    expect(deriveUuid("ioBroker")).toBe(deriveUuid("ioBroker"));
  });
  it("differs for different names", () => {
    expect(deriveUuid("Living Room")).not.toBe(deriveUuid("Bedroom"));
  });
  it("has the Roku serial shape (32-char hex)", () => {
    expect(deriveUuid("ioBroker")).toMatch(/^[0-9a-f]{32}$/);
  });
});
