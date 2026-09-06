import { planNativePrune, planObjectCleanup } from "./object-cleanup";

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

describe("planNativePrune", () => {
  const state = (native: Record<string, unknown>): ioBroker.Object =>
    ({ type: "state", common: { name: "Home" }, native }) as unknown as ioBroker.Object;

  it("finds an object carrying a native attribute this version does not write", () => {
    // The pre-0.5.0 adapter wrote native.url on every key state; extendObject merges, so
    // it survives every update. Only a full write removes it.
    const objects = new Map([
      ["Wohnzimmer.keys.Home", state({ url: "keys/Home" })],
      ["Wohnzimmer.keys.Back", state({})],
    ]);
    expect(planNativePrune(objects).map(([id]) => id)).toEqual(["Wohnzimmer.keys.Home"]);
  });

  it("hands the object back untouched, so the caller can preserve common.custom", () => {
    const obj = state({ url: "keys/Home" });
    const [[, handed]] = planNativePrune(new Map([["Wohnzimmer.keys.Home", obj]]));
    expect(handed).toBe(obj);
  });

  it("skips what the sweep is deleting anyway, children included", () => {
    const objects = new Map([
      ["Alt", state({ url: "x" })],
      ["Alt.keys.Home", state({ url: "x" })],
      ["Neu.keys.Home", state({ url: "x" })],
    ]);
    expect(planNativePrune(objects, new Set(["Alt"])).map(([id]) => id)).toEqual(["Neu.keys.Home"]);
  });

  it("says nothing about a clean tree", () => {
    expect(planNativePrune(new Map([["Wohnzimmer.keys.Home", state({})]]))).toEqual([]);
  });
});
