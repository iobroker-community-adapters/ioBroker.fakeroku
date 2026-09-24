import type { CommandEvent } from "./ecp-command";

/**
 * Longest `command` value written. The text comes straight from the request URL,
 * which a LAN client controls up to Node's header limit (16 KiB) — bounding it
 * keeps a flood of oversized values out of the states database. Real commands
 * (a key name, `launch:<id>`, a search keyword) stay far below this.
 */
export const MAX_COMMAND_LENGTH = 500;

/** The emulated Roku device type — decides which keys the device exposes. */
export type DeviceType = "player" | "tv";

/**
 * The base Roku remote keys every device type understands (ECP universal keys
 * plus FindRemote). A "player" (streaming box/stick) exposes exactly these.
 */
export const BASE_KEYS = [
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
  "FindRemote",
] as const;

/**
 * The extra keys only a Roku TV understands: volume, power, channel and input. A "tv" device
 * exposes {@link BASE_KEYS} plus these.
 *
 * The input list is Roku's own (ECP documentation: InputTuner, InputHDMI1–4, InputAV1). The power
 * keys go beyond the documented PowerOff because the controllers send them: `PowerOn` (Home
 * Assistant/rokuecp, openHAB, node-roku-client), `Power` (Homey, node-roku-client, rokuecp) and
 * `Sleep` (rokuecp). A key a controller sends but no state carries only ever reaches `command`.
 */
export const TV_KEYS = [
  "VolumeUp",
  "VolumeDown",
  "VolumeMute",
  "PowerOff",
  "PowerOn",
  "Power",
  "Sleep",
  "ChannelUp",
  "ChannelDown",
  "InputTuner",
  "InputHDMI1",
  "InputHDMI2",
  "InputHDMI3",
  "InputHDMI4",
  "InputAV1",
] as const;

/** Every key any device type can carry — used to recognise a keypress as a standard key. */
const ALL_KEYS: ReadonlySet<string> = new Set<string>([...BASE_KEYS, ...TV_KEYS]);

/**
 * The standard keys by their lower-case spelling. A real Roku takes a key name in any case — the
 * ECP documentation itself sends `keydown/left`, openHAB sends `POWERON` — so `home` must pulse
 * `keys.Home` like `Home` does, not only land in `command` as an unknown word.
 */
const KEY_BY_LOWER: ReadonlyMap<string, string> = new Map([...ALL_KEYS].map(key => [key.toLowerCase(), key]));

/**
 * The canonical spelling of a standard key, or the key unchanged when it is none (`Lit_a`, an
 * unknown word) — the typed character of a `Lit_` key keeps its case.
 *
 * @param key the key name as the controller sent it
 * @returns the canonical key name
 */
export function canonicalKey(key: string): string {
  return KEY_BY_LOWER.get(key.toLowerCase()) ?? key;
}

/**
 * The key set a device of the given type exposes: BASE_KEYS for a player, plus
 * TV_KEYS for a TV.
 *
 * @param type the device type
 * @returns the ordered list of key names to create for the device
 */
export function keysForType(type: DeviceType): readonly string[] {
  return type === "tv" ? [...BASE_KEYS, ...TV_KEYS] : BASE_KEYS;
}

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
      return `${cmd.type}:${cmd.appId ?? ""}${cmd.text ? `?${cmd.text}` : ""}`;
    case "input":
    case "search":
      return `${cmd.type}:${cmd.text ?? ""}`;
  }
}

/**
 * Map a parsed ECP command to the state writes it produces. Pure — a non-standard
 * key (keyboard `Lit_` input) or an app/input/search yields only the `command`
 * string, never its own object (that was the old adapter's per-character sprawl).
 * A key is flagged for `pulseKey`/`holdKey` if it is a standard key at all; the
 * adapter still checks whether *this* device actually carries it before writing.
 *
 * @param cmd the parsed ECP command
 * @returns the state writes
 */
export function commandToStateWrite(cmd: CommandEvent): StateWrite {
  const key = cmd.key === undefined ? undefined : canonicalKey(cmd.key);
  const canonical: CommandEvent = key === undefined ? cmd : { ...cmd, key };
  const write: StateWrite = {
    command: describeCommand(canonical).slice(0, MAX_COMMAND_LENGTH),
    commandType: cmd.type,
    pulseKey: null,
    holdKey: null,
  };
  if (key && ALL_KEYS.has(key)) {
    if (cmd.type === "keypress") {
      write.pulseKey = key;
    } else if (cmd.type === "keydown") {
      write.holdKey = { key, value: true };
    } else if (cmd.type === "keyup") {
      write.holdKey = { key, value: false };
    }
  }
  return write;
}
