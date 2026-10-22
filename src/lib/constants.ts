/**
 * Shared constants for the Roku emulator — kept in one place so the runtime
 * (main.ts) and the admin device-manager (device-management.ts) cannot drift apart.
 */

/**
 * The real-Roku ECP port and this adapter's default. Harmony and Sofabaton read the port
 * from the SSDP advertisement; Home Assistant (rokuecp) and Homey always use 8060, so
 * 8060 belongs to the Roku they should control.
 */
export const DEFAULT_ECP_PORT = 8060;

/**
 * Object-id segments the adapter reserves for its own tree — an emulated Roku may
 * not take one. `info` carries `info.connection`, the instance's own status; a
 * device of that name would turn the adapter's channel into a device object and
 * hang its command/keys states underneath it.
 *
 * Enforced in BOTH directions: the device manager refuses the name in the dialog,
 * and the runtime skips such a row, because native.devices is user-editable
 * (expert mode, CLI) and can carry what the dialog never allowed.
 */
export const RESERVED_IDS: ReadonlySet<string> = new Set(["info"]);

/**
 * The id of this instance's own object — where `native.devices` and the settings live.
 *
 * @param namespace the adapter namespace, e.g. `fakeroku.0`
 * @returns `system.adapter.<namespace>`
 */
export function instanceObjectId(namespace: string): string {
  return `system.adapter.${namespace}`;
}

/** The adapter's own objects below `info` — never device leftovers, never swept. */
export const OWN_INFO_IDS: ReadonlySet<string> = new Set([
  "info",
  "info.connection",
  "info.devicesTotal",
  "info.devicesOnline",
  "info.devicesAllOnline",
]);

/** The eleven languages every ioBroker manifest and admin translation carries. */
export const LANGUAGES = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"] as const;

/** A Roku's online indicator, relative to its device object: true while its ECP server listens. */
export const DEVICE_ONLINE_ID = "info.online";

/** A Roku's reason, relative to its device object: `Unknown`, empty while it runs, else why it does not. */
export const DEVICE_ERROR_ID = "info.error";

/** How long to wait before trying again what does not run: a device whose ECP server is down, and discovery. */
export const RETRY_INTERVAL_MS = 60_000;

/** The tail of every line about something that does not run and comes back on its own. */
export const RETRY_NOTE = `retrying every ${RETRY_INTERVAL_MS / 1000} s`;
