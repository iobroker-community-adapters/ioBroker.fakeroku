import { I18n } from "@iobroker/adapter-core";
import type translations from "../../admin/i18n/en.json";

type I18nKey = keyof typeof translations;

/** The eleven languages every ioBroker manifest and admin translation carries. */
const LANGUAGES = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"] as const;

/**
 * Translation object for a user-facing string, with optional `%s` interpolation.
 * Returns all admin languages (via adapter-core `I18n.getTranslatedObject`) so
 * device-manager titles, dialogs and confirmations render correctly regardless
 * of the admin language.
 *
 * @param key translation key from admin/i18n/en.json
 * @param args optional values substituted into the key's `%s` placeholders
 * @returns the translated string object
 */
export function t(key: I18nKey, ...args: (string | number | boolean | null)[]): ioBroker.StringOrTranslated {
  return I18n.getTranslatedObject(key, ...args);
}

/**
 * Translation object for an object's `common.name`. Same mechanism as {@link t};
 * a separate function so the intent is visible at the call site and the fleet's
 * state-role gate can tell a name from an explanation.
 *
 * @param key translation key from admin/i18n/en.json
 * @returns the translated name object
 */
export function tName(key: I18nKey): ioBroker.StringOrTranslated {
  return I18n.getTranslatedObject(key);
}

/**
 * Translation object for an object's `common.desc` — the short explanation a user
 * reads next to the name. Never the protocol's identifier, never the name again.
 *
 * @param key translation key from admin/i18n/en.json
 * @returns the translated description object
 */
export function tDesc(key: I18nKey): ioBroker.StringOrTranslated {
  return I18n.getTranslatedObject(key);
}

/**
 * Wrap a text that comes from the Roku protocol — a remote key name such as
 * `Home` or `VolumeUp` — as a translation object.
 *
 * There is nothing to translate (the key names are ECP identifiers and identical
 * in every language), but `common.name` must be a translation object for every
 * object type, never a bare string (core team, nut2 #15). Offering the same text
 * under every language key makes the object browser show it in any system
 * language instead of falling back on an untranslated name.
 *
 * @param text the protocol-provided text
 * @returns the same text under every language key
 */
export function tRaw(text: string): ioBroker.StringOrTranslated {
  return Object.fromEntries(LANGUAGES.map(lang => [lang, text])) as ioBroker.StringOrTranslated;
}
