import { networkInterfaces } from "node:os";
import { type InterfaceMap, isOwnPeer, type LocalNet, localNets } from "./network-address";

/** One interface to join the SSDP multicast group on: its name and its IPv4 address. */
export interface Membership {
  /** The interface name — a group membership belongs to the interface, not to one address. */
  iface: string;
  /** The IPv4 address the membership and the outgoing NOTIFY use. */
  address: string;
}

/**
 * The address announced when no interface is chosen and nothing more specific is known: the host's first IPv4. Every
 * search is answered with the host's address in the searcher's own network and every NOTIFY carries the address of
 * the interface it leaves through, so this one only names the host in the log. Pure.
 *
 * @param interfaces the OS network-interface map
 * @returns the first IPv4 address, or "" if the host has none
 */
export function pickPrimaryIPv4(interfaces: InterfaceMap): string {
  return localNets(interfaces).find(net => net.family === "IPv4")?.address ?? "";
}

/**
 * The interfaces to join the SSDP multicast group on: ONE entry per interface (its first IPv4) —
 * a membership belongs to the interface, and joining it a second time through another address of
 * the same card throws EADDRINUSE. Pure.
 *
 * @param interfaces the OS network-interface map
 * @returns the interfaces to join on (may be empty)
 */
export function pickMembershipIPv4s(interfaces: InterfaceMap): Membership[] {
  const byIface = new Map<string, LocalNet>();
  for (const net of localNets(interfaces)) {
    if (net.family === "IPv4" && !byIface.has(net.iface)) {
      byIface.set(net.iface, net);
    }
  }
  return [...byIface.values()].map(net => ({ iface: net.iface, address: net.address }));
}

/**
 * Best-effort primary IPv4 of the host.
 *
 * @returns the primary IPv4 address, or "" if none is found
 */
export function detectPrimaryIPv4(): string {
  return pickPrimaryIPv4(networkInterfaces());
}

/**
 * The host's interfaces to join the SSDP multicast group on when no interface is chosen.
 *
 * @returns the interfaces to join on (may be empty)
 */
export function detectLocalIPv4s(): Membership[] {
  return pickMembershipIPv4s(networkInterfaces());
}

/**
 * An address as the socket reports it, without the IPv4-mapped prefix a dual-stack socket puts in front of an IPv4
 * client (`::ffff:192.168.1.5` → `192.168.1.5`) — for the log line that names the client.
 *
 * @param address the socket address
 * @returns the plain address
 */
export function stripMappedPrefix(address: string): string {
  return address.replace(/^::ffff:/i, "");
}

/**
 * The host's own IPv4 address in the network a remote sits in — the address that remote can
 * reach. On a host with several networks a search from the IoT VLAN must be answered with the
 * host's IoT VLAN address, not with the address of another network the remote cannot route to.
 * Each network is asked on its own, through the fleet master's network check.
 *
 * @param remote the remote's address
 * @param nets the host's networks
 * @returns the host's address in the remote's network, or undefined if it shares none
 */
export function localAddressFor(remote: string, nets: readonly LocalNet[] = localNets()): string | undefined {
  return nets.find(net => net.family === "IPv4" && isOwnPeer(remote, net.address, [net]))?.address;
}
