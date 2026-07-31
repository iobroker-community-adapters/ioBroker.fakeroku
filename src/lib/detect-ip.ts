import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/**
 * Pick the first non-internal IPv4 from a set of OS network interfaces. Pure —
 * takes the interface map so it can be unit-tested without real network cards.
 *
 * @param interfaces the OS network-interface map (os.networkInterfaces() shape)
 * @returns the first routable IPv4 address, or "" if none is found
 */
export function pickPrimaryIPv4(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string {
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs ?? []) {
      // Node typed `family` as the string "IPv4" historically and as the number
      // 4 since v18 — accept both so detection works across runtimes.
      const isV4 = addr.family === "IPv4" || (addr.family as unknown as number) === 4;
      if (isV4 && !addr.internal) {
        return addr.address;
      }
    }
  }
  return "";
}

/**
 * Best-effort primary IPv4 of the host — used as the advertised SSDP LOCATION
 * when no interface is configured, so a controller gets a routable IP instead of
 * the bind wildcard (`0.0.0.0` is not reachable). Returns "" when the host has no
 * routable IPv4 (e.g. no network), which the caller treats as "cannot advertise".
 *
 * @returns the primary IPv4 address, or "" if none is found
 */
export function detectPrimaryIPv4(): string {
  return pickPrimaryIPv4(networkInterfaces());
}
