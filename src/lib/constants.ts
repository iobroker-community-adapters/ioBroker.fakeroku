/**
 * Shared constants for the Roku emulator — kept in one place so the runtime
 * (main.ts) and the admin device-manager (device-management.ts) cannot drift apart.
 */

/**
 * The real-Roku ECP port and this adapter's default. A controller reads the
 * actual port from the SSDP advertisement, so any free port works; 8060 is the
 * risk-free default (it also covers controllers that assume the standard port).
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

/** The adapter's own objects below `info` — never device leftovers, never swept. */
export const OWN_INFO_IDS: ReadonlySet<string> = new Set(["info", "info.connection"]);
