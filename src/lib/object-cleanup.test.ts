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

  it("sweeps the leftovers of a hand-edited device row named 'info'", () => {
    // Such a row turned the adapter's own channel into a device and hung its
    // states underneath. Skipping the whole `info` subtree kept them for good.
    const plan = planObjectCleanup(
      ["info", "info.connection", "info.command", "info.commandType", "info.keys", "info.keys.Home"],
      new Set(["ioBroker"]),
      BASE,
    );
    expect(plan).toEqual(["info.command", "info.commandType", "info.keys"]);
  });

  it("keeps info.connection even while sweeping its siblings", () => {
    const plan = planObjectCleanup(["info.connection", "info.keys.Home"], new Set(["ioBroker"]), BASE);
    expect(plan).not.toContain("info.connection");
    expect(plan).toEqual(["info.keys"]);
  });

  it("never sweeps info.connection, not even through a child path", () => {
    // Nothing creates such an id today; the guard is what keeps a future one from
    // taking the instance's own status down with it.
    const plan = planObjectCleanup(["info.connection.extra"], new Set(["ioBroker"]), BASE);
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
