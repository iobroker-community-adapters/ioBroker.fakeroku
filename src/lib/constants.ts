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
