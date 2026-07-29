/**
 * Pure string helpers for the Roku emulator — no ioBroker or network dependencies,
 * kept isolated so they can be unit-tested on their own.
 */

/**
 * Make a string safe as an ioBroker object-id segment: every character outside
 * `[A-Za-z0-9-_]` becomes `_`.
 *
 * @param raw the raw device or key name
 * @returns the id-safe string
 */
export function sanitizeId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9\-_]/g, "_");
}

/**
 * Normalize a Roku key name taken from the ECP URL path:
 * decode the URL-encoded character of a `Lit_<char>` keyboard keypress, then
 * replace ALL dots with `_` (the old adapter's `replace('.', '_')` only hit the first).
 *
 * @param raw the raw key segment from the request URL
 * @returns the normalized key name
 */
export function normalizeKey(raw: string): string {
  const decoded = raw.startsWith("Lit_") ? `Lit_${decodeURIComponent(raw.slice(4))}` : raw;
  return decoded.replace(/\./g, "_");
}
