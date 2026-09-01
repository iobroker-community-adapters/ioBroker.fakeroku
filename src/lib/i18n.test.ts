// The adapter-core entry point looks up an installed js-controller at import time
// and exits the process when none is there (unit tests run without one). The i18n
// module itself needs neither — the package exports it on its own, so the mock hands
// exactly that real module out under the name `t()` imports.
vi.mock("@iobroker/adapter-core", async () => ({ I18n: await import("@iobroker/adapter-core/i18n") }));

import { I18n } from "@iobroker/adapter-core";
import { join } from "node:path";
import { t } from "./i18n";

const LANGS = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];

describe("t() — device-manager texts from the real translation files", () => {
  beforeAll(async () => {
    // The same root main.ts hands to I18n.init: adapter-core looks for `<root>/i18n`,
    // so a passing init here also proves the flat admin/i18n/<lang>.json layout is
    // the one it loads.
    await I18n.init(join(__dirname, "..", "..", "admin"), "en");
  });

  it("substitutes the argument in every admin language", () => {
    const text = t("dmDeleteConfirm", "Wohnzimmer") as Record<string, string>;
    // A translation that lost its %s shows the user a confirmation without the
    // device name — exactly the dialog where the name matters most.
    for (const lang of LANGS) {
      expect(text[lang], lang).toContain("Wohnzimmer");
      expect(text[lang], lang).not.toContain("%s");
    }
  });

  it("returns a plain key in all eleven languages, not the key itself", () => {
    const text = t("dmAdd") as Record<string, string>;
    expect(Object.keys(text).sort()).toEqual([...LANGS].sort());
    expect(text.en).toBe("Add Roku device");
    expect(text.de).toBe("Roku-Gerät hinzufügen");
  });
});
