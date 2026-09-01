import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");

/**
 * Manifest wiring the integration boot test cannot see.
 */
describe("io-package.json manifest", () => {
  const io = JSON.parse(readFileSync(join(root, "io-package.json"), "utf8")) as {
    common?: { icon?: string; extIcon?: string; supportedMessages?: { deviceManager?: boolean } };
  };

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
});
