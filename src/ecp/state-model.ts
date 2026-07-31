import type { CommandEvent } from "./ecp-command";

/**
 * The fixed standard Roku remote key set. These get pre-created `sensor` boolean
 * states so the tree is usable from the first second — no lazy growth like the
 * old adapter (where only keys the Harmony had ever sent existed).
 */
export const STANDARD_KEYS = [
  "Home",
  "Rev",
  "Fwd",
  "Play",
  "Select",
  "Left",
  "Right",
  "Up",
  "Down",
  "Back",
  "InstantReplay",
  "Info",
  "Backspace",
  "Enter",
  "Search",
  "VolumeUp",
  "VolumeDown",
  "VolumeMute",
  "PowerOff",
  "ChannelUp",
  "ChannelDown",
  "InputHDMI1",
  "InputHDMI2",
  "InputHDMI3",
  "InputHDMI4",
  "InputAV1",
  "FindRemote",
] as const;

const STANDARD_KEY_SET: ReadonlySet<string> = new Set(STANDARD_KEYS);

/** What a command translates to in ioBroker state terms. The adapter performs the writes. */
export interface StateWrite {
  /** Human-readable last command for the `command` state (e.g. "Home", "launch:12", "search:news"). */
  command: string;
  /** The command type: keypress / keydown / keyup / launch / install / input / search. */
  commandType: string;
  /** For a keypress on a standard key: pulse this `keys.<Key>` true→false. null otherwise. */
  pulseKey: string | null;
  /** For keydown/keyup on a standard key: set this `keys.<Key>` to the given value. null otherwise. */
  holdKey: { key: string; value: boolean } | null;
}

/**
 * Describe a command as the plain-text value for the `command` state.
 *
 * @param cmd the parsed command
 * @returns the plain-text command value
 */
function describeCommand(cmd: CommandEvent): string {
  switch (cmd.type) {
    case "keypress":
    case "keydown":
    case "keyup":
      return cmd.key ?? "";
    case "launch":
    case "install":
      return `${cmd.type}:${cmd.appId ?? ""}`;
    case "input":
    case "search":
      return `${cmd.type}:${cmd.text ?? ""}`;
  }
}

/**
 * Map a parsed ECP command to the state writes it produces. Pure — a non-standard
 * key (keyboard `Lit_` input) or an app/input/search yields only the `command`
 * string, never its own object (that was the old adapter's per-character sprawl).
 *
 * @param cmd the parsed ECP command
 * @returns the state writes
 */
export function commandToStateWrite(cmd: CommandEvent): StateWrite {
  const write: StateWrite = {
    command: describeCommand(cmd),
    commandType: cmd.type,
    pulseKey: null,
    holdKey: null,
  };
  if (cmd.key && STANDARD_KEY_SET.has(cmd.key)) {
    if (cmd.type === "keypress") {
      write.pulseKey = cmd.key;
    } else if (cmd.type === "keydown") {
      write.holdKey = { key: cmd.key, value: true };
    } else if (cmd.type === "keyup") {
      write.holdKey = { key: cmd.key, value: false };
    }
  }
  return write;
}
