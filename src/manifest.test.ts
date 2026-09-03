import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");

/**
 * Manifest wiring the integration boot test cannot see.
 */
describe("io-package.json manifest", () => {
  const io = JSON.parse(readFileSync(join(root, "io-package.json"), "utf8")) as {
    common?: { icon?: string; extIcon?: string; supportedMessages?: { deviceManager?: boolean } };
    instanceObjects?: { _id: string; common?: { name?: unknown; desc?: unknown } }[];
  };
  const LANGS = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];

  // The device manager only works if `common.supportedMessages.deviceManager` is
  // set: without it the js-controller delivers no `dm:*` message, so neither the
  // add button nor the device cards appear — yet the adapter still boots green.
  it("enables device-manager messages (common.supportedMessages.deviceManager)", () => {
    expect(io.common?.supportedMessages?.deviceManager).toBe(true);
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
