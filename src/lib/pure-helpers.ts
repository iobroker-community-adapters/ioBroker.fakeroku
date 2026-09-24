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
 * Normalize a Roku key name taken from the ECP URL path: decode the character of a `Lit_<char>`
 * keyboard keypress (a malformed escape stays raw).
 *
 * The text is kept as typed. The old adapter replaced dots with `_` because every key became an
 * object id; here only the fixed standard keys have objects and none of them carries a dot, so a
 * replacement would only falsify the typed character (`Lit_.` reading `Lit__`).
 *
 * @param raw the raw key segment from the request URL
 * @returns the normalized key name
 */
export function normalizeKey(raw: string): string {
  return raw.startsWith("Lit_") ? `Lit_${decodeFormText(raw.slice(4))}` : raw;
}

/**
 * Decode URL text the way ECP clients encode it: `+` is a space (Python's `quote_plus`, which
 * Home Assistant's `rokuecp` uses for `Lit_` and search text — a real `+` arrives as `%2B`), then
 * the percent escapes. A malformed escape keeps the raw text.
 *
 * @param s the encoded text
 * @returns the decoded text, or the raw text (with `+` as space) if it cannot be decoded
 */
export function decodeFormText(s: string): string {
  return decodePercentEscapes(s.replace(/\+/g, " "));
}

/**
 * URL-decode a keyboard character, keeping the raw text when the escape is
 * malformed (`%ZZ`, a truncated `%E0%A4`). `decodeURIComponent` throws on those,
 * and this runs inside the HTTP request handler — an escaping throw there is an
 * uncaught exception that takes the whole adapter down over one bad request.
 *
 * @param s the percent-encoded text
 * @returns the decoded text, or the raw text if it cannot be decoded
 */
function decodePercentEscapes(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
