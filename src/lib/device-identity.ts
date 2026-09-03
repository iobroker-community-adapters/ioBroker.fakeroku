import { createHash } from "node:crypto";

/**
 * Derive a stable Roku device identity (serial / UDN) from the device name.
 *
 * Deterministic md5 of the name, so the emulated Roku keeps the same USN/serial
 * across restarts — unlike the old adapter, whose UUID changed between the first
 * two runs (bug A1) and re-paired the Harmony.
 *
 * Used only for a device that has no persisted `uuid`: the device manager stores
 * one when it CREATES a device (since 0.8.0), and main.ts adopts whatever is
 * stored. Rows the manager never created — the manifest's default device, or a
 * hand-written config — carry none, so their identity is this derivation from the
 * stored name. That is why an edit derives from the device's PREVIOUS name
 * (device-management.ts): deriving from the new one would move the identity on a
 * plain rename and unpair the remote.
 *
 * The exact output is pinned by a test — changing it would unpair every installed remote.
 *
 * @param name the configured device name
 * @returns a 32-char lowercase hex identity
 */
export function deriveUuid(name: string): string {
  return createHash("md5").update(`fakeroku:${name}`).digest("hex");
}

/**
 * The only shapes a device id ever had: the md5 hex the adapters derive, or a
 * dashed uuid from the old adapter. The value goes verbatim into SSDP headers and
 * XML, so anything else is replaced rather than emitted.
 */
const UUID_SHAPE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * The SSDP identity of one configured device: its persisted `uuid` when that is a
 * shape the adapters ever wrote, otherwise one derived from its name.
 *
 * THE single source for that decision. The runtime (main.ts) and the device
 * manager both call it — the manager so that an edit persists exactly the identity
 * the runtime is advertising at that moment, instead of computing a second,
 * different answer and unpairing the remote.
 *
 * @param device the stored device row
 * @param device.name the configured device name
 * @param device.uuid the persisted identity, if the row carries one
 * @returns the identity to advertise for this device
 */
export function resolveDeviceUuid(device: { name: string; uuid?: unknown }): string {
  return typeof device.uuid === "string" && UUID_SHAPE.test(device.uuid) ? device.uuid : deriveUuid(device.name);
}
