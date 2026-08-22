import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allChecks, formatFindings } from "iobroker-adapter-checks";

/** Repository root — this file sits in test/standards/. */
const adapterDir = join(__dirname, "..", "..");

describe("repository standards", () => {
  for (const check of allChecks) {
    it(check.title, () => {
      expect(formatFindings(check.run(adapterDir))).toBe("");
    });
  }
});
