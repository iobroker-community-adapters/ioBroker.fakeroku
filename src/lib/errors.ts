/**
 * Message of an unknown thrown value: `Error.message`, or the string form of a
 * non-Error (node bindings can reject with a bare string). One helper for every
 * log line that reports a caught value, so the idiom is not repeated per call site.
 *
 * @param e the caught value
 * @returns its message or a string form
 */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
