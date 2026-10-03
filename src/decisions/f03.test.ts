// Guard of F-03 (krobi 2026-09-01 22:06 / 22:11): the symbol is the existing admin/fakeroku.svg — for icon, extIcon and
// the README head; it is not drawn anew. Sealed in the register — a change goes through the Werkbank.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const common = (JSON.parse(readFileSync(join(root, "io-package.json"), "utf8")) as { common: Record<string, string> })
  .common;

describe("F-03 — icon, extIcon and the README head show admin/fakeroku.svg", () => {
  it("keeps the symbol file", () => {
    expect(existsSync(join(root, "admin", "fakeroku.svg"))).toBe(true);
  });

  it("names it as icon and extIcon", () => {
    expect(common.icon).toBe("fakeroku.svg");
    expect(common.extIcon.endsWith("/admin/fakeroku.svg")).toBe(true);
  });

  it("shows it in the README head", () => {
    const head = readFileSync(join(root, "README.md"), "utf8").split("\n").slice(0, 5).join("\n");
    expect(head).toContain("admin/fakeroku.svg");
  });
});
