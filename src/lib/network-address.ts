// Fleet master (.consistency-master/src/lib/network-address.ts) — never edit the copy in an adapter.
//
// The address a user picks in the instance settings (jsonConfig `type: "ip"`) is the only one the adapter listens,
// sends and connects on — the cloud included (krobi 2026-10-03 00:27, 11:38). One the host does not carry falls back to
// every address with exactly one warning, and only a client in the chosen network — or, with every address, in one of the
// host's own networks — is answered (fakeroku F-05/F-06 as the fleet rule). This file is the one form of that core: what
// counts as "every address", whether the host carries an address, which networks are own, and whether a peer is in one.
// The sockets themselves stay the adapter's — the inventory suites "chosen network address" / "missing network address"
// judge what it does with them.
import { BlockList, isIPv6 } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/** The OS network-interface map (the `os.networkInterfaces()` shape). */
export type InterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** One network the host itself sits in: an address of one of its interfaces, with its prefix. */
export interface LocalNet {
  /** The interface name (`eth0`, `wlan0` …). */
  iface: string;
  /** The address family. */
  family: "IPv4" | "IPv6";
  /** The host's own address in this network (IPv6 without a zone suffix). */
  address: string;
  /** The prefix length of the network (from `cidr`). */
  prefixLength: number;
}

/**
 * The chosen address of a setting, or undefined for "every address": the empty value and the wildcards `0.0.0.0` and
 * `::` (what the admin's "all" choice stores) choose none.
 *
 * @param value the native value as stored
 * @returns the chosen address, trimmed
 */
export function chosenAddress(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" || text === "0.0.0.0" || text === "::" ? undefined : text;
}

/**
 * Every network the host sits in. Loopback is left out — it is no network a device sits in; an address without a
 * usable prefix counts as just itself (/32, /128). Pure when the map is handed in.
 *
 * @param interfaces the OS network-interface map, read fresh when not given
 * @returns the host's networks, in enumeration order
 */
export function localNets(interfaces: InterfaceMap = networkInterfaces()): LocalNet[] {
  const out: LocalNet[] = [];
  for (const [iface, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.internal || (addr.family !== "IPv4" && addr.family !== "IPv6")) {
        continue;
      }
      const bits = typeof addr.cidr === "string" ? Number(addr.cidr.split("/")[1]) : NaN;
      const prefixLength = Number.isInteger(bits) ? bits : addr.family === "IPv4" ? 32 : 128;
      const address = addr.family === "IPv6" ? addr.address.split("%")[0].toLowerCase() : addr.address;
      out.push({ iface, family: addr.family, address, prefixLength });
    }
  }
  return out;
}

/**
 * Does the host carry this address on one of its interfaces? A chosen address it does not carry falls back to every
 * address, with exactly one warning.
 *
 * @param address the chosen address
 * @param nets the host's networks
 * @returns true if an interface carries it
 */
export function carriesAddress(address: string, nets: readonly LocalNet[] = localNets()): boolean {
  const plain = address.split("%")[0].toLowerCase();
  return nets.some(net => net.address === plain);
}

/**
 * The networks that count as own: with a chosen address the networks of the interface that carries it, otherwise every
 * network of the host.
 *
 * @param address the chosen address, undefined for every address
 * @param nets the host's networks
 * @returns the own networks (empty when no interface carries the chosen address)
 */
export function ownNets(address: string | undefined, nets: readonly LocalNet[] = localNets()): LocalNet[] {
  if (address === undefined) {
    return [...nets];
  }
  const plain = address.split("%")[0].toLowerCase();
  const iface = nets.find(net => net.address === plain)?.iface;
  return iface === undefined ? [] : nets.filter(net => net.iface === iface);
}

/**
 * Is a peer in one of the own networks? There is no exception: not loopback, not link-local unless the interface
 * carries such an address, not a routed private network. A dual-stack socket's IPv4-mapped form counts as the IPv4 it
 * carries; anything that is no IP address is in no network.
 *
 * @param peer the peer address from the socket
 * @param address the chosen address, undefined for every address
 * @param nets the host's networks
 * @returns true if the peer may be answered
 */
export function isOwnPeer(
  peer: string | undefined,
  address: string | undefined,
  nets: readonly LocalNet[] = localNets(),
): boolean {
  if (!peer) {
    return false;
  }
  const ip = peer
    .replace(/^::ffff:/i, "")
    .split("%")[0]
    .toLowerCase();
  return ownNets(address, nets).some(net => {
    try {
      const list = new BlockList();
      list.addSubnet(net.address, net.prefixLength, net.family === "IPv4" ? "ipv4" : "ipv6");
      return list.check(ip, isIPv6(ip) ? "ipv6" : "ipv4");
    } catch {
      // a peer in a form the check refuses lies in no network
      return false;
    }
  });
}
