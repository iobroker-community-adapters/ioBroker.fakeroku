import { createHash } from "node:crypto";

/**
 * Derive a stable Roku device identity (serial / UDN) from the device name.
 *
 * Deterministic md5 of the name, so the emulated Roku keeps the same USN/serial
 * across restarts — unlike the old adapter, whose UUID changed between the first
 * two runs (bug A1) and re-paired the Harmony. Milestone 2 (device-info) may
 * replace this with a persisted, richer identity; for discovery a stable
 * per-name value is enough.
 *
 * @param name the configured device name
 * @returns a 32-char lowercase hex identity
 */
export function deriveUuid(name: string): string {
  return createHash("md5").update(`fakeroku:${name}`).digest("hex");
}
