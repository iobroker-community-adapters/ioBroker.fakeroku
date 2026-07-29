/**
 * LAN restriction for the ECP HTTP server: only accept commands from private /
 * local networks. The old adapter accepted key presses from any reachable IP.
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
  return false;
}
