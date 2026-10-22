/**
 * The keys an emulated Roku carries, by device type — the one table the protocol model (ecp/state-model), the object
 * tree (main.ts) and the settings reader (device-config) share.
 */

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
