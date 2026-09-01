import { normalizeKey, sanitizeId } from "./pure-helpers";

describe("sanitizeId", () => {
  it("replaces dots and spaces with underscore", () => {
    expect(sanitizeId("Living Room.TV")).toBe("Living_Room_TV");
  });
  it("keeps allowed characters (letters, digits, dash, underscore) untouched", () => {
    expect(sanitizeId("Home-1_A")).toBe("Home-1_A");
  });
});

describe("normalizeKey", () => {
  it("replaces ALL dots, not just the first (the old adapter's replace('.','_') bug)", () => {
    expect(normalizeKey("Lit_a.b")).toBe("Lit_a_b");
  });
  it("decodes URL-encoded Lit_ characters", () => {
    expect(normalizeKey("Lit_%C3%A4")).toBe("Lit_ä");
  });
  it("keeps a malformed or truncated escape raw", () => {
    expect(normalizeKey("Lit_%ZZ")).toBe("Lit_%ZZ");
    expect(normalizeKey("Lit_%E0%A4")).toBe("Lit_%E0%A4");
  });
  it("leaves a plain key unchanged", () => {
    expect(normalizeKey("Home")).toBe("Home");
  });
});
