// t() returns something identifiable instead of a translation object, so the tests assert
// on the message CHOICE, not on wording.
vi.mock("./i18n", () => ({ t: (key: string, ...args: unknown[]) => (args.length ? { key, args } : key) }));

import {
  deviceObjectId,
  findClash,
  nextFreePort,
  normalizePort,
  normalizeType,
  toDeviceRow,
  toDeviceRows,
} from "./device-config";
import { deriveUuid, resolveDeviceUuid } from "./device-identity";

describe("normalizePort", () => {
  it("keeps a usable port", () => {
    expect(normalizePort(8061)).toBe(8061);
    expect(normalizePort("8061")).toBe(8061);
  });

  it("falls back to the adapter default for anything a server cannot bind", () => {
    // A hand-edited config reaches server.listen() unchecked otherwise, and the device
    // then fails to start with a message about a port that never existed.
    expect(normalizePort(-5)).toBe(8060);
    expect(normalizePort(0)).toBe(8060);
    expect(normalizePort(70000)).toBe(8060);
    expect(normalizePort("abc")).toBe(8060);
    expect(normalizePort(undefined)).toBe(8060);
    expect(normalizePort(null)).toBe(8060);
  });

  it("truncates a fractional port instead of handing a float to listen()", () => {
    expect(normalizePort(8060.7)).toBe(8060);
  });
});

describe("normalizeType", () => {
  it("only the literal tv is a TV; everything else is a player", () => {
    expect(normalizeType("tv")).toBe("tv");
    expect(normalizeType("player")).toBe("player");
    expect(normalizeType(undefined)).toBe("player"); // a row from before 0.7.0
    expect(normalizeType("TV")).toBe("player");
  });
});

describe("toDeviceRow", () => {
  it("keeps the stored name AND the trimmed one apart", () => {
    // This is the whole point of the type: the object id and the SSDP identity come from
    // the stored name, the card and the next write use the trimmed one.
    const row = toDeviceRow({ name: "  Roku  ", port: 8060, type: "player" })!;
    expect(row.storedName).toBe("  Roku  ");
    expect(row.name).toBe("Roku");
  });

  it("resolves the identity from the STORED name, never from the trimmed one", () => {
    // The bug this prevents: the manager normalised first and derived the identity from
    // the trimmed name, so saving a card — without changing anything — handed the remote
    // a different device than it was paired with.
    const stored = { name: " Roku ", port: 8060, type: "player" };
    const row = toDeviceRow(stored)!;
    expect(row.identity).toBe(resolveDeviceUuid(stored));
    expect(row.identity).toBe(deriveUuid(" Roku "));
    expect(row.identity).not.toBe(deriveUuid("Roku"));
  });

  it("adopts a persisted identity and reports nothing to repair", () => {
    const row = toDeviceRow({ name: "Roku", port: 8060, uuid: "keep-me" })!;
    expect(row.identity).toBe("keep-me");
    expect(row.identityReplaced).toBe(false);
  });

  it("replaces a persisted id that is not a shape the adapters ever wrote, and says so", () => {
    const row = toDeviceRow({ name: "Roku", port: 8060, uuid: "not a/valid id" })!;
    expect(row.identity).toBe(deriveUuid("Roku"));
    expect(row.identityReplaced).toBe(true);
  });

  it("reports a replaced port so the runtime can name it in the log", () => {
    expect(toDeviceRow({ name: "Roku", port: -5 })!.portReplaced).toBe(true);
    expect(toDeviceRow({ name: "Roku", port: 8060 })!.portReplaced).toBe(false);
    // A row that never carried a port takes the default silently — that is not a repair.
    expect(toDeviceRow({ name: "Roku" })!.portReplaced).toBe(false);
  });

  it("rejects a row without a usable name", () => {
    expect(toDeviceRow({ port: 8060 })).toBeNull();
    expect(toDeviceRow({ name: "", port: 8060 })).toBeNull();
    expect(toDeviceRow({ name: "   ", port: 8060 })).toBeNull();
    expect(toDeviceRow({ name: 42, port: 8060 })).toBeNull();
    expect(toDeviceRow(null)).toBeNull();
    expect(toDeviceRow("nonsense")).toBeNull();
  });
});

describe("toDeviceRows", () => {
  it("separates 'no devices key at all' from 'the user deleted everything'", () => {
    // null must never reach the orphan sweep as an empty set, or a config we could not
    // read would delete the whole tree.
    expect(toDeviceRows(undefined)).toBeNull();
    expect(toDeviceRows("nonsense")).toBeNull();
    expect(toDeviceRows([])).toEqual([]);
  });

  it("drops unusable rows and keeps the rest", () => {
    const rows = toDeviceRows([
      { name: "A", port: 8060 },
      null,
      { name: "  ", port: 8061 },
      { name: "B", port: 8061 },
    ])!;
    expect(rows.map(r => r.name)).toEqual(["A", "B"]);
  });
});

describe("deviceObjectId", () => {
  it("is built from the stored name, so an existing tree does not wander on an update", () => {
    expect(deviceObjectId(toDeviceRow({ name: " Roku " })!)).toBe("_Roku_");
    expect(deviceObjectId(toDeviceRow({ name: "My Roku!" })!)).toBe("My_Roku_");
  });
});

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

describe("findClash", () => {
  const devices = [
    { name: "Living room", port: 8060 },
    { name: "Kitchen", port: 8061 },
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
