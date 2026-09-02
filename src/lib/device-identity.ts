import { createHash } from "node:crypto";

/**
 * Derive a stable Roku device identity (serial / UDN) from the device name.
 *
 * Deterministic md5 of the name, so the emulated Roku keeps the same USN/serial
 * across restarts — unlike the old adapter, whose UUID changed between the first
 * two runs (bug A1) and re-paired the Harmony. Used only for a device that has no
 * persisted `uuid` yet: the device manager stores one on creation (since 0.8.0)
 * and main.ts adopts it, so a rename never changes the identity. The exact output
 * is pinned by a test — changing it would unpair every installed remote.
 *
 * @param name the configured device name
 * @returns a 32-char lowercase hex identity
 */
export function deriveUuid(name: string): string {
  return createHash("md5").update(`fakeroku:${name}`).digest("hex");
}
