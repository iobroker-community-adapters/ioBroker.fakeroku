import { cleanDevice, findClash, nextFreePort } from "./device-management";

// t() only needs to return something identifiable so findClash's branch is visible.
vi.mock("./lib/i18n", () => ({ t: (k: string) => k }));

describe("nextFreePort", () => {
  it("returns the real-Roku default when nothing is taken", () => {
    expect(nextFreePort([])).toBe(8060);
  });

  it("skips a run of taken ports", () => {
    expect(nextFreePort([8060, 8061, 8062])).toBe(8063);
  });

  it("returns 8060 when only a higher port is taken", () => {
    expect(nextFreePort([9000])).toBe(8060);
  });
});

describe("cleanDevice", () => {
  it("trims the name, coerces the port, defaults an unknown type to player", () => {
    expect(cleanDevice({ name: "  Living room  ", port: "8060", type: "x" })).toEqual({
      name: "Living room",
      port: 8060,
      type: "player",
    });
  });

  it("keeps a tv type and falls back to the default port on garbage", () => {
    expect(cleanDevice({ name: "TV", port: "abc", type: "tv" })).toEqual({ name: "TV", port: 8060, type: "tv" });
  });
});

describe("findClash", () => {
  const devices = [
    { name: "Living room", port: 8060, type: "player" as const },
    { name: "Kitchen", port: 8061, type: "tv" as const },
  ];

  it("flags a duplicate name case-insensitively", () => {
    expect(findClash(devices, { name: "living ROOM", port: 9000 }, -1)).toBe("deviceNameInUse");
  });

  it("flags a duplicate port", () => {
    expect(findClash(devices, { name: "New", port: 8061 }, -1)).toBe("devicePortInUse");
  });

  it("returns null when both name and port are free", () => {
    expect(findClash(devices, { name: "New", port: 9000 }, -1)).toBeNull();
  });

  it("excludes the edited device so its own name+port do not clash with itself", () => {
    expect(findClash(devices, { name: "Living room", port: 8060 }, 0)).toBeNull();
  });

  it("rejects a name that maps to the reserved 'info' object id", () => {
    expect(findClash(devices, { name: "info", port: 9000 }, -1)).toBe("deviceNameInvalid");
  });

  it("rejects a different name that sanitizes to the same id as another device", () => {
    // "Living room" and "Living*room" both sanitize to "Living_room" — distinct
    // names, same object tree. The plain-name check misses it; the id check catches it.
    expect(findClash(devices, { name: "Living*room", port: 9000 }, -1)).toBe("deviceNameInvalid");
  });
});
