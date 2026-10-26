import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceIcon, ICON_BY_TYPE, ICON_URI_PREFIX, normaliseLineEndings } from "./device-icons";
import type * as DeviceIcons from "./device-icons";
import type * as Fs from "node:fs";

const iconDir = join(__dirname, "..", "..", "admin", "icons");

/** Written out, not read from the map: a test against the map itself would accept a TV pointing at the player. */
const EXPECTED: Record<string, string> = { player: "player.svg", tv: "tv.svg" };

/**
 * The markup a URI carries.
 *
 * @param uri the data URI
 * @returns the decoded SVG text
 */
function decode(uri: string): string {
  return Buffer.from(uri.slice(ICON_URI_PREFIX.length), "base64").toString("utf8");
}

describe("deviceIcon", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("maps every device type to its own file", () => {
    expect({ ...ICON_BY_TYPE }).toEqual(EXPECTED);
  });

  it("embeds the bytes of the type's file as an inline SVG URI, never a path", () => {
    for (const [type, file] of Object.entries(EXPECTED)) {
      const uri = deviceIcon(type);
      expect(uri?.startsWith(ICON_URI_PREFIX), type).toBe(true);
      expect(decode(uri!)).toBe(normaliseLineEndings(readFileSync(join(iconDir, file), "utf8")));
    }
  });

  it("gives the same value on every call", () => {
    expect(deviceIcon("tv")).toBe(deviceIcon("tv"));
  });

  it("gives the same URI from a CRLF checkout", async () => {
    const file = join(iconDir, "tv.svg");
    const original = readFileSync(file, "utf8");
    const lf = deviceIcon("tv");
    try {
      // From either checkout: the Windows runner already has CRLF here.
      writeFileSync(file, original.replace(/\r?\n/g, "\r\n"));
      vi.resetModules();
      const fresh = await vi.importActual<typeof DeviceIcons>("./device-icons");
      expect(fresh.deviceIcon("tv")).toBe(lf);
    } finally {
      writeFileSync(file, original);
    }
  });

  it("leaves the field alone for an unknown type, an inherited name or no type", () => {
    expect(deviceIcon("stick")).toBeUndefined();
    expect(deviceIcon("constructor")).toBeUndefined();
    expect(deviceIcon(undefined)).toBeUndefined();
  });

  it("reads a file once, however many devices of that type start", async () => {
    const actual = await vi.importActual<typeof Fs>("node:fs");
    const readFileSync = vi.fn(actual.readFileSync);
    vi.doMock("node:fs", () => ({ readFileSync }));
    vi.resetModules();
    const fresh = await vi.importActual<typeof DeviceIcons>("./device-icons");
    fresh.deviceIcon("tv");
    fresh.deviceIcon("tv");
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });

  it("leaves the field alone when the file cannot be read", async () => {
    vi.doMock("node:fs", () => ({
      readFileSync: () => {
        throw new Error("ENOENT");
      },
    }));
    vi.resetModules();
    const fresh = await vi.importActual<typeof DeviceIcons>("./device-icons");
    expect(fresh.deviceIcon("player")).toBeUndefined();
  });
});

describe("admin/icons", () => {
  const files = readdirSync(iconDir);

  it("holds one file per device type and nothing else", () => {
    expect(files.sort()).toEqual(Object.values(EXPECTED).sort());
  });

  it("draws in the row's text colour only", () => {
    for (const file of files) {
      const svg = readFileSync(join(iconDir, file), "utf8");
      const colours = [...svg.matchAll(/\b(?:fill|stroke)="([^"]*)"/g)].map(m => m[1]);
      expect(colours.length, file).toBeGreaterThan(0);
      expect(
        colours.filter(c => c !== "currentColor" && c !== "none"),
        file,
      ).toEqual([]);
    }
  });

  it("draws with path and circle only — the object browser gives other shapes no width", () => {
    for (const file of files) {
      const inner = readFileSync(join(iconDir, file), "utf8").replace(/^<svg[^>]*>/, "");
      expect(inner.match(/<(rect|image|use|svg|foreignObject)\b/g), file).toBeNull();
    }
  });
});
