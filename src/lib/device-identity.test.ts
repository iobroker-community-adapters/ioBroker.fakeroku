import { deriveUuid, resolveDeviceUuid } from "./device-identity";

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

describe("resolveDeviceUuid", () => {
  it("adopts a persisted hex identity unchanged", () => {
    const uuid = deriveUuid("Roku");
    expect(resolveDeviceUuid({ name: "renamed", uuid })).toBe(uuid);
  });

  it("adopts a dashed uuid from the old adapter unchanged", () => {
    const uuid = "29c4c1c9-3f52-5b1e-8f0e-b827eb1a2b3c";
    expect(resolveDeviceUuid({ name: "Roku", uuid })).toBe(uuid);
  });

  it("derives from the name when no identity is stored", () => {
    expect(resolveDeviceUuid({ name: "Roku" })).toBe(deriveUuid("Roku"));
    expect(resolveDeviceUuid({ name: "Roku", uuid: "" })).toBe(deriveUuid("Roku"));
  });

  it("replaces a stored value that cannot go into an SSDP header or XML", () => {
    // The value is emitted verbatim in `USN: uuid:roku:ecp:<v>` and in the device
    // XML — a space, a slash or a newline would break the datagram or the document.
    for (const bad of ["not a valid id", "a/b", "x\r\ny", "<tag>", "a".repeat(65)]) {
      expect(resolveDeviceUuid({ name: "Roku", uuid: bad })).toBe(deriveUuid("Roku"));
    }
  });

  it("ignores a non-string identity", () => {
    expect(resolveDeviceUuid({ name: "Roku", uuid: 42 })).toBe(deriveUuid("Roku"));
    expect(resolveDeviceUuid({ name: "Roku", uuid: null })).toBe(deriveUuid("Roku"));
  });
});
