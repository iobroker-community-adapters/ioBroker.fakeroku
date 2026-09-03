import { detectLocalIPv6Prefixes, ipv6Prefix64 } from "./detect-ip";

/**
 * LAN restriction for both network services (ECP HTTP + SSDP): only accept
 * requests from private / local networks — the IPv4 private and link-local ranges, loopback, and the IPv6
 * link-local / unique-local ranges. The old adapter accepted key presses from any
 * reachable IP.
 *
 * A globally routable IPv6 address is accepted when it sits in one of the host's
 * OWN /64 prefixes. On a connection with native IPv6 the router hands every
 * device in the house an address out of the provider's block, so a remote on the
 * same link looks exactly like an internet host — the shared prefix is what tells
 * them apart. Anything from a different prefix stays out, as before. The prefixes
 * are read lazily and only for such an address, so the common IPv4 case does not
 * touch the network interfaces at all, and a provider's prefix change is picked
 * up on the next request instead of being frozen at start-up.
 *
 * @param remoteAddress the client IP from the request socket
 * @param localPrefixes supplies the host's own IPv6 /64 prefixes (injected for tests)
 * @returns true if the client is on a private/local network
 */
export function isLanClient(
  remoteAddress: string | undefined,
  localPrefixes: () => readonly string[] = detectLocalIPv6Prefixes,
): boolean {
  if (!remoteAddress) {
    return false;
  }
  const ip = remoteAddress.replace(/^::ffff:/, "");
  if (ip === "127.0.0.1" || ip === "::1") {
    return true;
  }
  if (/^10\./.test(ip)) {
    return true;
  }
  if (/^192\.168\./.test(ip)) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) {
    return true;
  }
  if (/^169\.254\./.test(ip)) {
    return true;
  }
  // IPv6 in the LAN: link-local (fe80::/10, possibly with a `%zone` suffix) and
  // unique-local (fc00::/7). A remote on an IPv6-only segment is still local.
  const v6 = ip.toLowerCase();
  if (/^fe[89ab][0-9a-f]:/.test(v6) || /^f[cd][0-9a-f]{2}:/.test(v6)) {
    return true;
  }
  // A globally routable IPv6 address: local exactly when it shares one of the
  // host's own /64 network prefixes.
  const prefix = ipv6Prefix64(v6);
  return prefix !== null && localPrefixes().includes(prefix);
}
