import { decodeFormText, normalizeKey, sanitizeId } from "./pure-helpers";

describe("sanitizeId", () => {
  it("replaces dots and spaces with underscore", () => {
    expect(sanitizeId("Living Room.TV")).toBe("Living_Room_TV");
  });
  it("keeps allowed characters (letters, digits, dash, underscore) untouched", () => {
    expect(sanitizeId("Home-1_A")).toBe("Home-1_A");
  });
});

describe("normalizeKey", () => {
  it("keeps a typed dot as a dot — only the standard keys have objects, none carries one", () => {
    expect(normalizeKey("Lit_.")).toBe("Lit_.");
  });
  it("reads + as a space and %2B as a plus, the way rokuecp's quote_plus encodes them", () => {
    expect(normalizeKey("Lit_+")).toBe("Lit_ ");
    expect(normalizeKey("Lit_%2B")).toBe("Lit_+");
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

describe("decodeFormText", () => {
  it("decodes form-encoded text and keeps a malformed escape raw", () => {
    expect(decodeFormText("keyword=news+today%21")).toBe("keyword=news today!");
    expect(decodeFormText("a%ZZ+b")).toBe("a%ZZ b");
  });
});
