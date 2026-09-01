/**
 * LAN restriction for both network services (ECP HTTP + SSDP): only accept
 * requests from private / local networks — the IPv4 private and link-local ranges, loopback, and the IPv6
 * link-local / unique-local ranges. The old adapter accepted key presses from any
 * reachable IP.
 *
 * @param remoteAddress the client IP from the request socket
 * @returns true if the client is on a private/local network
 */
export function isLanClient(remoteAddress: string | undefined): boolean {
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
  return false;
}
