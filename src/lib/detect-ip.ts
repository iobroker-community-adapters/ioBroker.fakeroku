import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/**
 * Is this a routable (non-internal) IPv4 address?
 *
 * @param addr one entry from an os.networkInterfaces() list
 * @returns true for a non-internal IPv4 address
 */
function isRoutableIPv4(addr: NetworkInterfaceInfo): boolean {
  return addr.family === "IPv4" && !addr.internal;
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
 * The container-bridge networks Docker hands out by default: `docker0` (172.17.x.x)
 * and the first user-defined / compose bridge (172.18.x.x). They are non-internal
 * IPv4 addresses like any other, but nothing on the LAN can reach them.
 */
const CONTAINER_BRIDGE_PREFIXES = ["172.17.", "172.18."];

/**
 * Is this address one of Docker's default bridge networks?
 *
 * @param address an IPv4 address
 * @returns true for a Docker default-bridge address
 */
function isContainerBridge(address: string): boolean {
  return CONTAINER_BRIDGE_PREFIXES.some(prefix => address.startsWith(prefix));
}

/**
 * Pick the address to advertise from a set of OS network interfaces: the first
 * routable IPv4 that is NOT a Docker default bridge, and only as a last resort a
 * bridge address. Pure — takes the interface map so it can be unit-tested without
 * real network cards.
 *
 * Why the exception exists: an ioBroker host commonly runs Docker, and `docker0`
 * (172.17.x.x) or the first compose bridge (172.18.x.x) can come first in the
 * interface enumeration. Advertising one of them puts an address into every SSDP
 * answer and NOTIFY that no remote on the LAN can reach — while the adapter starts
 * green and reports "advertising on 172.17.0.1", which looks like success. The
 * sibling emulator hit exactly this (hassemu v1.21.0) and fixed it the same way, so
 * the fleet gives one answer instead of two.
 *
 * @param interfaces the OS network-interface map (os.networkInterfaces() shape)
 * @returns the routable IPv4 address to advertise, or "" if none is found
 */
export function pickPrimaryIPv4(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string {
  const addresses = listNonInternalIPv4s(interfaces);
  return addresses.find(address => !isContainerBridge(address)) ?? addresses[0] ?? "";
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

/**
 * Expand an IPv6 address to its eight four-digit groups, resolving the `::`
 * shorthand and dropping a `%zone` suffix. Returns null for anything that is not
 * a plain IPv6 address (an IPv4-mapped form, a malformed value).
 *
 * @param address the IPv6 address text
 * @returns the eight normalised groups, or null
 */
function expandIPv6(address: string): string[] | null {
  const bare = address.toLowerCase().split("%")[0];
  if (!bare.includes(":") || bare.includes(".")) {
    return null; // not IPv6, or an IPv4-mapped/embedded form
  }
  const halves = bare.split("::");
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const groups =
    halves.length === 2 ? [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail] : head;
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) {
    return null;
  }
  return groups.map(g => g.padStart(4, "0"));
}

/**
 * The /64 network prefix of an IPv6 address — its first four groups. A /64 is
 * exactly one network segment (the size SLAAC assigns), so two addresses sharing
 * it are on the same link.
 *
 * @param address the IPv6 address text
 * @returns the normalised prefix (e.g. "2003:00e1:1f28:9a00"), or null
 */
export function ipv6Prefix64(address: string): string | null {
  const groups = expandIPv6(address);
  return groups ? groups.slice(0, 4).join(":") : null;
}

/**
 * The /64 prefixes of every non-internal IPv6 address of the given interface map.
 * Pure — takes the interface map so it can be unit-tested without real network
 * cards.
 *
 * These are what makes a globally routable IPv6 client recognisable as local: on
 * a modern connection the router hands every device in the house an address out
 * of the provider's block, which looks exactly like an internet address. Only the
 * shared prefix tells "the TV in the living room" from "a host on the internet".
 *
 * @param interfaces the OS network-interface map (os.networkInterfaces() shape)
 * @returns every /64 prefix the host itself is in (may be empty), de-duplicated
 */
export function listLocalIPv6Prefixes(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const out = new Set<string>();
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv6" || addr.internal) {
        continue;
      }
      const prefix = ipv6Prefix64(addr.address);
      if (prefix) {
        out.add(prefix);
      }
    }
  }
  return [...out];
}

/**
 * The /64 prefixes of the host's own IPv6 addresses — the LAN guard's notion of
 * "my network" for a globally routable client.
 *
 * @returns every /64 prefix the host is in (may be empty)
 */
export function detectLocalIPv6Prefixes(): string[] {
  return listLocalIPv6Prefixes(networkInterfaces());
}
