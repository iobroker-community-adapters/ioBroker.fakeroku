import { planObjectCleanup } from "./object-cleanup";

const KEYS = new Set(["Home", "Play", "Select"]);

describe("planObjectCleanup", () => {
  it("removes the legacy apps node of a configured device", () => {
    const plan = planObjectCleanup(["ioBroker", "ioBroker.command", "ioBroker.apps"], new Set(["ioBroker"]), KEYS);
    expect(plan).toEqual(["ioBroker.apps"]);
  });

  it("removes a non-standard key but keeps standard ones", () => {
    const plan = planObjectCleanup(
      ["ioBroker.keys.Home", "ioBroker.keys.Play", "ioBroker.keys.Enter"],
      new Set(["ioBroker"]),
      KEYS,
    );
    expect(plan).toEqual(["ioBroker.keys.Enter"]);
  });

  it("removes a whole orphaned device tree (rename/removal), de-duplicated", () => {
    const plan = planObjectCleanup(
      ["ioBroker.command", "OldName", "OldName.command", "OldName.keys.Home"],
      new Set(["ioBroker"]),
      KEYS,
    );
    expect(plan).toEqual(["OldName"]);
  });

  it("never touches the adapter's own info channel", () => {
    const plan = planObjectCleanup(["info", "info.connection"], new Set(["ioBroker"]), KEYS);
    expect(plan).toEqual([]);
  });

  it("keeps a fully current device untouched", () => {
    const plan = planObjectCleanup(
      ["ioBroker", "ioBroker.command", "ioBroker.commandType", "ioBroker.keys", "ioBroker.keys.Home"],
      new Set(["ioBroker"]),
      KEYS,
    );
    expect(plan).toEqual([]);
  });
});
