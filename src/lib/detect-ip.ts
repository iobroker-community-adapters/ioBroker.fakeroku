import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/**
 * Is this a routable (non-internal) IPv4 address? Node typed `family` as the
 * string "IPv4" historically and as the number 4 since v18 — accept both so
 * detection works across runtimes.
 *
 * @param addr one entry from an os.networkInterfaces() list
 * @returns true for a non-internal IPv4 address
 */
function isRoutableIPv4(addr: NetworkInterfaceInfo): boolean {
  const isV4 = addr.family === "IPv4" || (addr.family as unknown as number) === 4;
  return isV4 && !addr.internal;
}

/**
 * Every non-internal IPv4 address of the given interface map, in enumeration
 * order. Pure — takes the interface map so it can be unit-tested without real
 * network cards.
 *
 * @param interfaces the OS network-interface map (os.networkInterfaces() shape)
 * @returns every routable IPv4 address (may be empty)
 */
export function listNonInternalIPv4s(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs ?? []) {
      if (isRoutableIPv4(addr)) {
        out.push(addr.address);
      }
    }
  }
  return out;
}

/**
 * Pick the first non-internal IPv4 from a set of OS network interfaces. Pure —
 * takes the interface map so it can be unit-tested without real network cards.
 *
 * @param interfaces the OS network-interface map (os.networkInterfaces() shape)
 * @returns the first routable IPv4 address, or "" if none is found
 */
export function pickPrimaryIPv4(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string {
  return listNonInternalIPv4s(interfaces)[0] ?? "";
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

/**
 * All routable IPv4 addresses of the host — the interfaces to join the SSDP
 * multicast group on when no specific interface is configured, so discovery
 * works on every LAN the host is on. Without this a multi-homed host only hears
 * M-SEARCH on the OS default interface. Empty when the host has no routable IPv4.
 *
 * @returns every routable IPv4 address of the host (may be empty)
 */
export function detectLocalIPv4s(): string[] {
  return listNonInternalIPv4s(networkInterfaces());
}
