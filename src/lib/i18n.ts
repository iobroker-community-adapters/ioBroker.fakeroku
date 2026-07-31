import { I18n } from "@iobroker/adapter-core";
import type translations from "../../admin/i18n/en.json";

type I18nKey = keyof typeof translations;

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
