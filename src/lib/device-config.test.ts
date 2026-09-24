// t() returns something identifiable instead of a translation object, so the tests assert
// on the message CHOICE, not on wording.
vi.mock("./i18n", () => ({ t: (key: string, ...args: unknown[]) => (args.length ? { key, args } : key) }));

import {
  deviceObjectId,
  deviceTreeOf,
  findClash,
  isUsableObjectId,
  legacyObjectId,
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
  it("is built from the stored name when nothing else is known", () => {
    expect(deviceObjectId(toDeviceRow({ name: " Roku " })!)).toBe("_Roku_");
    expect(deviceObjectId(toDeviceRow({ name: "My Roku!" })!)).toBe("My_Roku_");
  });

  it("is the stored objectId once there is one — a rename never moves the tree", () => {
    const row = toDeviceRow({ name: "Lounge", port: 8060, type: "player", objectId: "Living_room" })!;
    expect(deviceObjectId(row)).toBe("Living_room");
    expect(row.objectIdDerived).toBe(false);
  });

  it("ignores a stored objectId that cannot be an object id segment", () => {
    const row = toDeviceRow({ name: "Roku", port: 8060, type: "player", objectId: "a.b" })!;
    expect(deviceObjectId(row)).toBe("Roku");
    expect(row.objectIdDerived).toBe(true);
  });

  it("keeps the tree the OLD adapter built for a name with an umlaut, a bracket or two spaces", () => {
    // The pre-0.6.0 adapter replaced only dots and whitespace runs; the rebuild replaces every
    // character outside [A-Za-z0-9-_] one by one. Without the bridge the orphan sweep deleted the
    // old tree — values, room assignments and history settings with it.
    for (const [name, legacy] of [
      ["Küche", "Küche"],
      ["Roku (Wohnzimmer)", "Roku_(Wohnzimmer)"],
      ["Roku  TV", "Roku_TV"],
    ]) {
      expect(legacyObjectId(name)).toBe(legacy);
      const tree = deviceTreeOf([legacy], () => "device");
      expect(deviceObjectId(toDeviceRow({ name, port: 9093 }, tree)!), name).toBe(legacy);
    }
  });

  it("prefers today's id when the tree already lives there", () => {
    const tree = deviceTreeOf(["K_che", "Küche"], () => "device");
    expect(deviceObjectId(toDeviceRow({ name: "Küche" }, tree)!)).toBe("K_che");
  });

  it("counts only device objects as a tree, not a state that happens to carry the name", () => {
    const tree = deviceTreeOf(["Küche"], () => "state");
    expect(deviceObjectId(toDeviceRow({ name: "Küche" }, tree)!)).toBe("K_che");
  });
});

describe("isUsableObjectId", () => {
  it("allows what js-controller allows in one segment (7.2.2 FORBIDDEN_CHARS), no dot", () => {
    for (const id of ["Roku", "Küche", "Roku_(Wohnzimmer)", "a#b", "x-y_z"]) {
      expect(isUsableObjectId(id), id).toBe(true);
    }
    for (const id of ["", "a.b", "a*b", "a,b", 'a"b', "a;b"]) {
      expect(isUsableObjectId(id), id).toBe(false);
    }
  });
});

describe("a row from before 0.7.0 (no type stored)", () => {
  it("is a TV when its tree carries TV keys, so the sweep keeps them", () => {
    const tree = deviceTreeOf(["TV", "TV.keys", "TV.keys.Home", "TV.keys.VolumeUp"], id =>
      id === "TV" ? "device" : id === "TV.keys" ? "channel" : "state",
    );
    expect(toDeviceRow({ name: "TV", port: 9093 }, tree)!.type).toBe("tv");
  });

  it("stays a player without TV keys, and a stored type always wins", () => {
    const tree = deviceTreeOf(["P", "P.keys.Home"], id => (id === "P" ? "device" : "state"));
    expect(toDeviceRow({ name: "P", port: 9093 }, tree)!.type).toBe("player");
    const tvTree = deviceTreeOf(["T", "T.keys.VolumeUp"], id => (id === "T" ? "device" : "state"));
    expect(toDeviceRow({ name: "T", port: 8060, type: "player" }, tvTree)!.type).toBe("player");
  });

  it("falls back to the old adapter's port 9093 for an unusable port", () => {
    // The old adapter used parseInt(port) || 9093 — a remote paired with such a device found it
    // there; 8060 would move it.
    expect(toDeviceRow({ name: "Old", port: "" })!.port).toBe(9093);
    expect(toDeviceRow({ name: "New", port: "", type: "player" })!.port).toBe(8060);
  });
});

describe("identityDerived", () => {
  it("tells a stored identity from one derived from the name", () => {
    expect(toDeviceRow({ name: "A", uuid: "0123456789abcdef0123456789abcdef" })!.identityDerived).toBe(false);
    expect(toDeviceRow({ name: "A" })!.identityDerived).toBe(true);
    expect(toDeviceRow({ name: "A", uuid: "bad id" })!.identityDerived).toBe(true);
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
  // Built the way production builds them, so the rows carry the STORED name next to the
  // displayed one — the two differ exactly where this check used to look at the wrong one.
  const devices = toDeviceRows([
    { name: "Living room", port: 8060, type: "player" },
    { name: "Kitchen", port: 8061, type: "player" },
  ])!;

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

  it("judges no object id for an edit — the device keeps the id it has", () => {
    // "Kitchen" renamed to "Living*room": a new device would land on Living_room, a renamed
    // one stays on Kitchen.
    expect(findClash(devices, { name: "Living*room", port: 8061 }, 1)).toBeNull();
    expect(findClash(devices, { name: "info", port: 8061 }, 1)).toBeNull();
    expect(findClash(devices, { name: "   ", port: 8061 }, 1)).toBe("deviceNameInvalid");
  });

  it("rejects a name that maps to the reserved 'info' object id", () => {
    expect(findClash(devices, { name: "info", port: 9000 }, -1)).toBe("deviceNameInvalid");
  });

  it("rejects a different name that sanitizes to the same id as another device", () => {
    // "Living room" and "Living*room" both sanitize to "Living_room" — distinct
    // names, same object tree. The plain-name check misses it; the id check catches it.
    expect(findClash(devices, { name: "Living*room", port: 9000 }, -1)).toBe("deviceNameInvalid");
  });

  it("judges the id of the STORED name, not of the name the list displays", () => {
    // A hand-edited row " Roku " displays as "Roku" but occupies "Roku_" in the object tree,
    // because the tree is built from the stored name. Comparing the displayed name let a new
    // device literally called "Roku_" pass both the dialog and this check — and the start
    // then skipped it as a duplicate object id, leaving info.connection false for good.
    const stored = toDeviceRows([{ name: " Roku ", port: 8060, type: "player" }])!;
    expect(deviceObjectId(stored[0])).toBe("_Roku_");
    expect(findClash(stored, { name: "_Roku_", port: 9000 }, -1)).toBe("deviceNameInvalid");
    // The displayed name is still free — that is a different question and stays answerable.
    expect(findClash(stored, { name: "Kitchen", port: 9000 }, -1)).toBeNull();
  });
});
