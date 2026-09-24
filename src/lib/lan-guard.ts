import { detectLocalNets, inNet, type LocalNet } from "./detect-ip";

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
 * Always accepted, without asking the interfaces: loopback (the host itself) and the link-local
 * ranges 169.254.0.0/16 and fe80::/10 — a link-local address is on the same wire by definition
 * (169.254 is what a remote self-assigns when the DHCP server is slow or gone, which is exactly
 * when the user troubleshoots).
 *
 * With a chosen interface the caller hands in only that interface's networks, so nothing outside
 * the chosen network gets an answer.
 *
 * @param remoteAddress the client IP from the socket
 * @param nets supplies the networks that count as own (read lazily, only for a routable client)
 * @returns true if the client is in one of the given networks
 */
export function isLanClient(
  remoteAddress: string | undefined,
  nets: () => readonly LocalNet[] = detectLocalNets,
): boolean {
  if (!remoteAddress) {
    return false;
  }
  const ip = remoteAddress.replace(/^::ffff:/i, "").toLowerCase();
  if (/^127\./.test(ip) || ip === "::1") {
    return true;
  }
  if (/^169\.254\./.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip)) {
    return true;
  }
  const family = ip.includes(":") ? "IPv6" : "IPv4";
  return nets().some(net => net.family === family && inNet(ip, net));
}
