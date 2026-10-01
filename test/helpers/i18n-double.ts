/**
 * The `t()` of `src/lib/i18n.ts` as the device-manager suites load it: the key itself, or the key with its arguments,
 * so a test asserts WHICH text was chosen without depending on its wording.
 *
 * @param key the translation key
 * @param args the values for its placeholders
 * @returns the key, or the key with its arguments
 */
export function t(key: string, ...args: unknown[]): unknown {
  return args.length ? { key, args } : key;
}
