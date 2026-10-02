import { detectLocalNets, inNet, type LocalNet, stripMappedPrefix } from "./detect-ip";

/**
 * The trust boundary of both network services (ECP HTTP + SSDP): only a client in one of the
 * host's OWN networks is answered — the old adapter accepted key presses from any reachable IP.
 *
 * "Own network" is measured, not guessed from address ranges: a client counts when it lies in the
 * network (address + prefix length) of one of the interfaces the caller hands in. That keeps a
 * routed private network out (another VLAN, a VPN such as Tailscale over 100.64/10 or its IPv6
 * ULA block), and it takes in a global IPv6 client from the host's own prefix — on a connection
 * with native IPv6 every device in the house carries such an address.
 *
 * There is no exception: not the host itself (loopback, never one of the networks handed in), not a
 * link-local address unless the interface carries one in that range. With a chosen interface the
 * caller hands in only that interface's networks, so nothing outside the chosen network gets an
 * answer.
 *
 * @param remoteAddress the client IP from the socket
 * @param nets supplies the networks that count as own
 * @returns true if the client is in one of the given networks
 */
export function isLanClient(
  remoteAddress: string | undefined,
  nets: () => readonly LocalNet[] = detectLocalNets,
): boolean {
  if (!remoteAddress) {
    return false;
  }
  const ip = stripMappedPrefix(remoteAddress).toLowerCase();
  const family = ip.includes(":") ? "IPv6" : "IPv4";
  return nets().some(net => net.family === family && inNet(ip, net));
}
