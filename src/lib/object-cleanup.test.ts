import { planObjectCleanup } from "./object-cleanup";

/**
 * One configured device "ioBroker" exposing the given keys.
 *
 * @param keys Key names the device exposes
 */
const valid = (keys: string[]): ReadonlyMap<string, ReadonlySet<string>> => new Map([["ioBroker", new Set(keys)]]);
const BASE = valid(["Home", "Play", "Select"]);

describe("planObjectCleanup", () => {
  it("removes the legacy apps node of a configured device", () => {
    const plan = planObjectCleanup(["ioBroker", "ioBroker.command", "ioBroker.apps"], new Set(["ioBroker"]), BASE);
    expect(plan).toEqual(["ioBroker.apps"]);
  });

  it("removes a key not in this device's type (e.g. a TV key after switching to player)", () => {
    const plan = planObjectCleanup(
      ["ioBroker.keys.Home", "ioBroker.keys.Play", "ioBroker.keys.VolumeUp"],
      new Set(["ioBroker"]),
      BASE,
    );
    expect(plan).toEqual(["ioBroker.keys.VolumeUp"]);
  });

  it("removes a whole orphaned device tree (rename/removal), de-duplicated", () => {
    const plan = planObjectCleanup(
      ["ioBroker.command", "OldName", "OldName.command", "OldName.keys.Home"],
      new Set(["ioBroker"]),
      BASE,
    );
    expect(plan).toEqual(["OldName"]);
  });

  it("never touches the adapter's own info channel", () => {
    const plan = planObjectCleanup(["info", "info.connection"], new Set(["ioBroker"]), BASE);
    expect(plan).toEqual([]);
  });

  it("keeps a fully current device untouched", () => {
    const plan = planObjectCleanup(
      ["ioBroker", "ioBroker.command", "ioBroker.commandType", "ioBroker.keys", "ioBroker.keys.Home"],
      new Set(["ioBroker"]),
      BASE,
    );
    expect(plan).toEqual([]);
  });
});
