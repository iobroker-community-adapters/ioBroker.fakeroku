import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/** The OS network-interface map (the `os.networkInterfaces()` shape). */
export type InterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** One network the host itself sits in: an address of one of its interfaces, with its prefix. */
export interface LocalNet {
  /** The interface name (`eth0`, `wlan0`, `docker0` …). */
  iface: string;
  /** The address family. */
  family: "IPv4" | "IPv6";
  /** The host's own address in this network (IPv6 without a zone suffix). */
  address: string;
  /** The prefix length of the network (from `cidr`, or derived from the netmask). */
  prefixLength: number;
  /** A virtual bridge (container, VM, WSL) — nothing on the LAN sits behind it. */
  virtual: boolean;
}

/** One interface to join the SSDP multicast group on: its name and its IPv4 address. */
export interface Membership {
  /** The interface name — a group membership belongs to the interface, not to one address. */
  iface: string;
  /** The IPv4 address the membership and the outgoing NOTIFY use. */
  address: string;
}

/**
 * Interface names of virtual bridges: Docker (`docker0`, compose/user networks `br-<id>`, the
 * container ends `veth…`), libvirt (`virbr…`), VirtualBox host-only (`vboxnet…`), Hyper-V/WSL
 * (`vEthernet (…)`), CNI/flannel/podman/LXC bridges. Recognised by NAME: Docker hands out
 * 172.17.0.0/16 up to 172.31.0.0/16 and then pools out of 192.168.0.0/16 (moby
 * `ipamutils`), so an address rule either misses the third compose network or collides with
 * ordinary LANs.
 */
const VIRTUAL_IFACE = /^(docker\d*|br-|veth|virbr|vboxnet|vEthernet|cni|flannel|podman|lxcbr)/i;

/** Docker's default bridges by address — the fallback for a bridge that carries an unusual name. */
const CONTAINER_BRIDGE_PREFIXES = ["172.17.", "172.18."];

/**
 * Is this interface a virtual bridge no remote on the LAN can reach?
 *
 * @param iface the interface name
 * @param address one of its IPv4 addresses
 * @returns true for a virtual bridge
 */
function isVirtual(iface: string, address: string): boolean {
  return VIRTUAL_IFACE.test(iface) || CONTAINER_BRIDGE_PREFIXES.some(prefix => address.startsWith(prefix));
}

/**
 * The prefix length of an interface address: from `cidr` when the OS gives it, else counted from
 * the netmask.
 *
 * @param addr one entry of an os.networkInterfaces() list
 * @returns the prefix length, or null when neither is usable
 */
function prefixLengthOf(addr: NetworkInterfaceInfo): number | null {
  const fromCidr = typeof addr.cidr === "string" ? Number(addr.cidr.split("/")[1]) : NaN;
  if (Number.isInteger(fromCidr)) {
    return fromCidr;
  }
  if (addr.family === "IPv4" && typeof addr.netmask === "string") {
    const bits = ipv4ToInt(addr.netmask);
    return bits === null ? null : bits.toString(2).replace(/0/g, "").length;
  }
  if (addr.family === "IPv6" && typeof addr.netmask === "string") {
    const groups = expandIPv6(addr.netmask);
    return groups ? groups.reduce((n, g) => n + parseInt(g, 16).toString(2).replace(/0/g, "").length, 0) : null;
  }
  return null;
}

/**
 * Every network the host sits in, from an interface map. Pure — takes the map so it can be
 * unit-tested without real network cards. Loopback is left out; an interface the OS reports
 * without addresses is skipped.
 *
 * @param interfaces the OS network-interface map
 * @returns the host's networks, in enumeration order
 */
export function listLocalNets(interfaces: InterfaceMap): LocalNet[] {
  const out: LocalNet[] = [];
  for (const [iface, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.internal || (addr.family !== "IPv4" && addr.family !== "IPv6")) {
        continue;
      }
      // Without a usable prefix only the address itself counts as the network (/32, /128): it
      // stays usable to bind and advertise, and the trust boundary grows by nothing.
      const prefixLength = prefixLengthOf(addr) ?? (addr.family === "IPv4" ? 32 : 128);
      const address = addr.family === "IPv6" ? addr.address.split("%")[0].toLowerCase() : addr.address;
      out.push({
        iface,
        family: addr.family,
        address,
        prefixLength,
        virtual: addr.family === "IPv4" && isVirtual(iface, address),
      });
    }
  }
  return out;
}

/**
 * Every non-internal IPv4 address of the given interface map, in enumeration order.
 *
 * @param interfaces the OS network-interface map
 * @returns every routable IPv4 address (may be empty)
 */
export function listNonInternalIPv4s(interfaces: InterfaceMap): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) {
        out.push(addr.address);
      }
    }
  }
  return out;
}

/**
 * The address to advertise when no interface is chosen and nothing better is known: the first
 * IPv4 that is not a virtual bridge, and a bridge address only as a last resort (inside a
 * container it is all there is). Pure.
 *
 * Why bridges are skipped: an ioBroker host commonly runs Docker, and a bridge can come first in
 * the interface enumeration. Advertising it puts an address into every SSDP answer that no remote
 * on the LAN can reach — while the adapter reports "advertising on 172.17.0.1", which looks like
 * success (hassemu v1.21.0 hit exactly this).
 *
 * @param interfaces the OS network-interface map
 * @returns the IPv4 address to advertise, or "" if none is found
 */
export function pickPrimaryIPv4(interfaces: InterfaceMap): string {
  const nets = listLocalNets(interfaces).filter(net => net.family === "IPv4");
  return (nets.find(net => !net.virtual) ?? nets[0])?.address ?? "";
}

/**
 * The interfaces to join the SSDP multicast group on: ONE entry per interface (its first IPv4) —
 * a membership belongs to the interface, and joining it a second time through another address of
 * the same card throws EADDRINUSE. Virtual bridges are left out unless they are all there is.
 * Pure.
 *
 * @param interfaces the OS network-interface map
 * @returns the interfaces to join on (may be empty)
 */
export function pickMembershipIPv4s(interfaces: InterfaceMap): Membership[] {
  const byIface = new Map<string, LocalNet>();
  for (const net of listLocalNets(interfaces)) {
    if (net.family === "IPv4" && !byIface.has(net.iface)) {
      byIface.set(net.iface, net);
    }
  }
  const all = [...byIface.values()];
  const real = all.filter(net => !net.virtual);
  return (real.length > 0 ? real : all).map(net => ({ iface: net.iface, address: net.address }));
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
 * The host's networks, read fresh — an address change (DHCP, a provider's IPv6 prefix) is seen on
 * the next call instead of being frozen at start-up.
 *
 * @returns the host's networks
 */
export function detectLocalNets(): LocalNet[] {
  return listLocalNets(networkInterfaces());
}

/**
 * Does the host carry this IPv4 address on one of its interfaces?
 *
 * @param address the address to look for
 * @param nets the host's networks
 * @returns true if an interface carries it
 */
export function hasLocalAddress(address: string, nets: readonly LocalNet[]): boolean {
  return nets.some(net => net.address === address);
}

/**
 * The networks of the interface that carries the given address — what "stay in the chosen
 * interface's network" means.
 *
 * @param address an address of the host
 * @param nets the host's networks
 * @returns the networks of that interface (empty if no interface carries the address)
 */
export function netsOfInterface(address: string, nets: readonly LocalNet[]): LocalNet[] {
  const owner = nets.find(net => net.address === address)?.iface;
  return owner === undefined ? [] : nets.filter(net => net.iface === owner);
}

/**
 * The host's own IPv4 address in the network a remote sits in — the address that remote can
 * reach. On a host with several networks a search from the IoT VLAN must be answered with the
 * host's IoT VLAN address, not with the address of another network the remote cannot route to.
 *
 * @param remote the remote's address
 * @param nets the host's networks
 * @returns the host's address in the remote's network, or undefined if it shares none
 */
export function localAddressFor(remote: string, nets: readonly LocalNet[]): string | undefined {
  const ip = remote.replace(/^::ffff:/i, "");
  return nets.find(net => net.family === "IPv4" && inNet(ip, net))?.address;
}

/**
 * Is an address inside one of the host's networks (by the network's prefix length)?
 *
 * @param address the address to test (IPv4, or IPv6 with an optional zone suffix)
 * @param net the network
 * @returns true if the address lies in the network
 */
export function inNet(address: string, net: LocalNet): boolean {
  if (net.family === "IPv4") {
    const a = ipv4ToInt(address);
    const n = ipv4ToInt(net.address);
    if (a === null || n === null) {
      return false;
    }
    const mask = net.prefixLength === 0 ? 0 : (~0 << (32 - net.prefixLength)) >>> 0;
    return (a & mask) >>> 0 === (n & mask) >>> 0;
  }
  const a = expandIPv6(address);
  const n = expandIPv6(net.address);
  if (!a || !n) {
    return false;
  }
  const bits = (groups: string[]): string => groups.map(g => parseInt(g, 16).toString(2).padStart(16, "0")).join("");
  return bits(a).slice(0, net.prefixLength) === bits(n).slice(0, net.prefixLength);
}

/**
 * An IPv4 address as an unsigned 32-bit number, or null if it is not a dotted quad.
 *
 * @param address the address text
 * @returns the number, or null
 */
function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p) || Number(p) > 255)) {
    return null;
  }
  return parts.reduce((n, p) => ((n << 8) | Number(p)) >>> 0, 0);
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
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 && fill < 1) {
    return null;
  }
  const groups = halves.length === 2 ? [...head, ...Array<string>(fill).fill("0"), ...tail] : head;
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) {
    return null;
  }
  return groups.map(g => g.padStart(4, "0"));
}
