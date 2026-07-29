import { normalizeKey } from "../lib/pure-helpers";

/** The ECP verbs a Roku remote sends via POST. */
export type CommandType = "keypress" | "keydown" | "keyup" | "launch" | "install" | "input" | "search";

/** A parsed ECP command from the Roku HTTP interface. */
export interface CommandEvent {
  /** The ECP verb. */
  type: CommandType;
  /** Normalized key name for key* verbs (e.g. "Home", "Lit_a"). */
  key?: string;
  /** App id for launch/install. */
  appId?: string;
  /** Raw query text for input/search. */
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
      return arg ? { type: verb, appId: arg } : null;
    case "input":
    case "search":
      return { type: verb, text: query ?? "" };
    default:
      return null;
  }
}
