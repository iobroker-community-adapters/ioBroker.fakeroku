import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_KEYS, TV_KEYS } from "./ecp/state-model";

const root = join(__dirname, "..");
/** The eleven languages every ioBroker manifest and admin translation carries. */
const LANGS = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];

/**
 * Manifest wiring the integration boot test cannot see.
 */
describe("io-package.json manifest", () => {
  const io = JSON.parse(readFileSync(join(root, "io-package.json"), "utf8")) as {
    common?: {
      icon?: string;
      extIcon?: string;
      supportedMessages?: Record<string, boolean>;
      compact?: boolean;
      singletonHost?: boolean;
    };
    instanceObjects?: { _id: string; common?: { name?: unknown; desc?: unknown } }[];
    native?: Record<string, unknown>;
  };

  // The device manager only works if `common.supportedMessages.deviceManager` is
  // set: without it the js-controller delivers no `dm:*` message, so neither the
  // add button nor the device cards appear — yet the adapter still boots green.
  it("enables device-manager messages (common.supportedMessages.deviceManager)", () => {
    expect(io.common?.supportedMessages?.deviceManager).toBe(true);
  });

  // stopInstance in that same list means onUnload never runs at all — no farewell, no
  // final info.connection write. The key is a positive list, so it must not appear even
  // as `false`: an object without a truthy entry silently shuts the messagebox.
  it("declares no message the adapter does not serve, stopInstance above all", () => {
    expect(Object.keys(io.common?.supportedMessages ?? {})).toEqual(["deviceManager"]);
  });

  // Compact mode: the host may load several instances into ONE node process, which saves
  // 40-80 MB and a startup per instance on small hardware. Declaring it costs nothing at
  // runtime — the user still switches it on — but the adapter has to earn the claim, and
  // the tests in main.test.ts ("two instances in one process") are where it is earned.
  // The whole fleet declares it; fakeroku carried `false` from the adapter it took over.
  it("declares compact mode, the way every adapter of the fleet does", () => {
    expect(io.common?.compact).toBe(true);
  });

  // `singletonHost` tells the host only ONE instance may run per machine. The repo checker
  // asks about it (S1084) because it is rarely warranted, and here it never was: a busy
  // SSDP port 1900 degrades to "discovery off, already-paired remotes still work", so a
  // second instance costs nothing. Setting it would forbid a perfectly good setup —
  // two emulated Rokus with different ECP ports on one machine.
  it("does not claim the whole host for itself", () => {
    expect(io.common?.singletonHost).toBeUndefined();
  });

  // The compact interface itself: loaded as a module rather than as the entry point, main
  // must EXPORT its constructor instead of starting an instance. Without that line the
  // manifest above would be a lie the host only discovers at runtime.
  it("exports its constructor when it is not the entry point", () => {
    const main = readFileSync(join(root, "src/main.ts"), "utf8");
    expect(main).toContain("if (require.main !== module)");
    expect(main).toMatch(/module\.exports\s*=\s*\(options[^)]*\)\s*=>\s*new Fakeroku\(options\)/);
  });

  // The device list is stored under `native.devices`, and that name is load-bearing:
  // js-controller clears the stored array before merging for exactly four key names
  // (`common.members`, `native.repositories`, `native.certificates`, `native.devices` —
  // adapter.ts `_extendForeignObject`). Under any other name extendObject would merge the
  // arrays element-wise, so writing a shorter list would leave the tail in place and a
  // deleted device would come back on the next start.
  it("keeps the device list under the one native key js-controller replaces instead of merging", () => {
    expect(io.native).toHaveProperty("devices");
    expect(Array.isArray(io.native?.devices)).toBe(true);
  });

  // The admin shows `common.icon`, GitHub shows the README logo. Until 1.3.0 these
  // were two different files that had lived side by side for a month — the admin
  // still showed the previous adapter's picture. One file, referenced everywhere.
  it("has exactly one icon file, and admin, repository and README all show it", () => {
    const icon = io.common?.icon;
    expect(icon, "common.icon").toBeTruthy();
    expect(existsSync(join(root, "admin", icon!)), `admin/${icon} exists`).toBe(true);
    expect(io.common?.extIcon?.endsWith(`/admin/${icon}`), "extIcon names the same file").toBe(true);
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const logo = readme.match(/^# <img src="([^"]+)"/m)?.[1];
    expect(logo?.endsWith(`/admin/${icon}`), "README logo names the same file").toBe(true);
    const pictures = readdirSync(join(root, "admin")).filter(f => /\.(svg|png|jpe?g|gif)$/i.test(f));
    expect(pictures, "no second icon file lingering next to the real one").toEqual([icon]);
  });

  // The manifest block is rendered from admin/i18n by the fleet's sync script. A
  // hand-edited plain string here would ship an English-only object name and fail
  // the state-role gate at the next release.
  it("names every instance object with a full eleven-language translation object", () => {
    expect(io.instanceObjects?.length, "instanceObjects present").toBeGreaterThan(0);
    for (const obj of io.instanceObjects ?? []) {
      const name = obj.common?.name;
      expect(typeof name, `${obj._id} common.name is not a plain string`).not.toBe("string");
      expect(Object.keys(name as Record<string, string>).sort(), `${obj._id} languages`).toEqual([...LANGS].sort());
    }
  });

  it("keeps every description a translation object, or leaves it out entirely", () => {
    // desc is an explanation where there is one to give; nothing to explain means
    // no desc at all — an invented sentence is worse than none.
    for (const obj of io.instanceObjects ?? []) {
      const desc = obj.common?.desc;
      if (desc === undefined || desc === null) {
        continue;
      }
      expect(typeof desc, `${obj._id} common.desc is not a plain string`).not.toBe("string");
      expect(Object.keys(desc as Record<string, string>).sort(), `${obj._id} languages`).toEqual([...LANGS].sort());
    }
  });
});

// ---------------------------------------------------------------------------
// Catalogue completeness — the decisions the object-inventory gate hands back to
// the adapter (fleet template, section "Objekt-Inventar"):
//   1. every language file carries exactly the keys en.json has,
//   2. no language file leaves a key empty,
//   3. no i18n key is dead,
//   4. the inventory really covers every key of every device type.
// The description decision itself — every datapoint either explained or declared
// self-explaining WITH a reason — lives in test/self-explaining.json since
// 2026-09-07, where check-object-inventory.py judges it for the whole fleet. It
// used to be a hand-kept list in this file, which no gate ever read.
// ---------------------------------------------------------------------------

describe("naming catalogue", () => {
  const i18nDir = join(root, "admin", "i18n");
  const en = JSON.parse(readFileSync(join(i18nDir, "en.json"), "utf8")) as Record<string, string>;

  it("every language file carries exactly the keys en.json has", () => {
    const expected = Object.keys(en).sort();
    for (const lang of LANGS) {
      const data = JSON.parse(readFileSync(join(i18nDir, `${lang}.json`), "utf8")) as Record<string, string>;
      const actual = Object.keys(data).sort();
      expect(
        expected.filter(k => !actual.includes(k)),
        `${lang}.json is missing keys`,
      ).toEqual([]);
      expect(
        actual.filter(k => !expected.includes(k)),
        `${lang}.json has keys en.json does not`,
      ).toEqual([]);
    }
  });

  it("no language file leaves a key empty", () => {
    for (const lang of LANGS) {
      const data = JSON.parse(readFileSync(join(i18nDir, `${lang}.json`), "utf8")) as Record<string, string>;
      const blank = Object.entries(data)
        .filter(([, v]) => typeof v !== "string" || v.trim() === "")
        .map(([k]) => k);
      expect(blank, `${lang}.json has blank values`).toEqual([]);
    }
  });

  it("carries no key nothing reads any more", () => {
    // A dead key is pure maintenance load: eleven files to keep in step for a text no
    // code asks for. The manifest and the admin panel are consumers too — the fleet's
    // sync script fills instanceObjects names/descs from these keys.
    const sources = [
      readFileSync(join(root, "src", "main.ts"), "utf8"),
      readFileSync(join(root, "src", "device-management.ts"), "utf8"),
      readFileSync(join(root, "io-package.json"), "utf8"),
      readFileSync(join(root, "admin", "jsonConfig.json"), "utf8"),
    ];
    const libDir = join(root, "src", "lib");
    for (const f of readdirSync(libDir).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
      sources.push(readFileSync(join(libDir, f), "utf8"));
    }
    const haystack = sources.join("\n");
    const dead = Object.keys(en).filter(k => !haystack.includes(`"${k}"`) && !haystack.includes(`'${k}'`));
    expect(dead, "i18n keys no source, manifest or panel reads").toEqual([]);
  });
});

describe("object inventory", () => {
  const inventoryFile = join(root, "test", "objects.inventory.json");
  const inventory = JSON.parse(readFileSync(inventoryFile, "utf8")) as Record<string, unknown>;

  it("covers every key of every device type", () => {
    // The gate can only judge what the inventory contains. A fixture that stopped
    // covering the TV would shrink the inventory and quietly narrow the check.
    const ids = Object.keys(inventory);
    for (const key of BASE_KEYS) {
      expect(ids, `player key ${key}`).toContain(`fakeroku.0.Player.keys.${key}`);
      expect(ids, `tv key ${key}`).toContain(`fakeroku.0.TV.keys.${key}`);
    }
    for (const key of TV_KEYS) {
      expect(ids, `tv-only key ${key}`).toContain(`fakeroku.0.TV.keys.${key}`);
      expect(ids, `player must NOT carry ${key}`).not.toContain(`fakeroku.0.Player.keys.${key}`);
    }
    for (const device of ["Player", "TV"]) {
      expect(ids).toContain(`fakeroku.0.${device}.command`);
      expect(ids).toContain(`fakeroku.0.${device}.commandType`);
    }
    expect(ids).toContain("fakeroku.0.info.connection");
  });
});
