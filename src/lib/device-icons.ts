import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceType } from "./roku-keys";

// The pictogram of an emulated Roku in the object browser (CLAUDE_PATTERNS.md, device pictograms): the file itself as an
// inline SVG URI — the admin puts that markup into the row, where `currentColor` follows the theme; a path would land in
// a bare <img> and keep one colour on every theme.

/** One file per device type under admin/icons. */
export const ICON_BY_TYPE: Readonly<Record<DeviceType, string>> = {
  player: "player.svg",
  tv: "tv.svg",
};

/** What every icon value starts with. */
export const ICON_URI_PREFIX = "data:image/svg+xml;base64,";

// build/lib AND src/lib both sit two levels below the adapter root.
const ICON_DIR = join(__dirname, "..", "..", "admin", "icons");
const cache = new Map<string, string | undefined>();

/**
 * The markup with LF line endings — a CRLF checkout (the Windows runner) would otherwise give another URI for the same file.
 *
 * @param svg the file content
 * @returns the content with LF line endings
 */
export function normaliseLineEndings(svg: string): string {
  return svg.replace(/\r\n/g, "\n");
}

/**
 * The inline data URI for a device type.
 *
 * @param type the device type
 * @returns the URI, or undefined for an unknown type or an unreadable file — the field then stays as it is
 */
export function deviceIcon(type: string | undefined): string | undefined {
  // "constructor" and friends are inherited, not entries of the map.
  if (type === undefined || !Object.hasOwn(ICON_BY_TYPE, type)) {
    return undefined;
  }
  if (cache.has(type)) {
    return cache.get(type);
  }
  const file = join(ICON_DIR, ICON_BY_TYPE[type as DeviceType]);
  let uri: string | undefined;
  try {
    const svg = readFileSync(file, "utf8");
    uri = `${ICON_URI_PREFIX}${Buffer.from(normaliseLineEndings(svg)).toString("base64")}`;
  } catch {
    uri = undefined;
  }
  cache.set(type, uri);
  return uri;
}
