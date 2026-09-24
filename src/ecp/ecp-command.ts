import { decodeFormText, normalizeKey } from "../lib/pure-helpers";

/** The ECP verbs a Roku remote sends via POST — also the value list of the `commandType` state. */
export const COMMAND_TYPES = ["keypress", "keydown", "keyup", "launch", "install", "input", "search"] as const;

/** One ECP verb. */
export type CommandType = (typeof COMMAND_TYPES)[number];

/** A parsed ECP command from the Roku HTTP interface. */
export interface CommandEvent {
  /** The ECP verb. */
  type: CommandType;
  /** Normalized key name for key* verbs (e.g. "Home", "Lit_a"). */
  key?: string;
  /** App id for launch/install. */
  appId?: string;
  /**
   * The decoded query text: what was typed or searched for (input/search), or the parameters a
   * launch/install carried (`contentId=…&mediaType=…`, a deep link into the app).
   */
  text?: string;
}

/**
 * Parse an ECP request (method + url) into a command event, or null if it is not
 * a POST command (a GET query, an unknown verb, or a missing argument).
 *
 * @param method the HTTP method
 * @param url the request URL (path plus optional query string)
 * @returns the parsed command, or null
 */
export function parseEcpCommand(method: string, url: string): CommandEvent | null {
  if (method !== "POST") {
    return null;
  }
  const [path, query] = url.split("?");
  const match = path.match(/^\/([^/]+)(?:\/(.+))?$/);
  if (!match) {
    return null;
  }
  const verb = match[1];
  const arg = match[2];
  switch (verb) {
    case "keypress":
    case "keydown":
    case "keyup":
      return arg ? { type: verb, key: normalizeKey(arg) } : null;
    case "launch":
    case "install":
      // The parameters are part of the command: the same app launched with another contentId is a
      // different button on the remote, and dropping them made the two indistinguishable.
      return arg ? { type: verb, appId: arg, ...(query ? { text: decodeFormText(query) } : {}) } : null;
    case "input":
    case "search":
      return { type: verb, text: decodeFormText(query ?? "") };
    default:
      return null;
  }
}
