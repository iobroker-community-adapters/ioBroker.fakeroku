/**
 * Pure SSDP message helpers for Roku ECP discovery — no sockets, so they can be
 * unit-tested directly. The socket wiring lives in ssdp-responder.ts.
 *
 * Roku's SSDP is NOT standard UPnP: it answers `ST: roku:ecp` with
 * `USN: uuid:roku:ecp:<uuid>` — the plain identity, with NO `::<device>` suffix.
 * (That suffix is exactly what node-ssdp's `addUSN` appends, which is why this
 * adapter builds the datagrams by hand.)
 */

/** One emulated Roku the responder announces. */
export interface RokuAdvert {
  /** Stable device identity, e.g. "8481b6831d0d8b1296cdd7e11acf6fca". */
  uuid: string;
  /** ECP HTTP port the device serves on. */
  port: number;
}

const SERVER_SIG = "Roku UPnP/1.0 MiniUPnPd/1.4";
const MAX_AGE = 3600;

/**
 * Does this datagram look like an M-SEARCH a Roku should answer? Requires the
 * M-SEARCH request line, `MAN: "ssdp:discover"`, and an ST of roku:ecp /
 * ssdp:all / upnp:rootdevice.
 *
 * @param message the raw datagram text
 * @returns true if a Roku response is warranted
 */
export function matchesRokuSearch(message: string): boolean {
  if (!/^M-SEARCH \* HTTP\/1\.1/im.test(message)) {
    return false;
  }
  if (!/^MAN:\s*"ssdp:discover"/im.test(message)) {
    return false;
  }
  const st = message.match(/^ST:\s*(.+?)\s*$/im)?.[1];
  return st === "roku:ecp" || st === "ssdp:all" || st === "upnp:rootdevice";
}

/**
 * Build the SSDP 200-OK response for one emulated Roku, in Roku's exact format
 * (USN without the node-ssdp `::device` suffix), advertising the given IP.
 *
 * @param device the emulated Roku
 * @param advertiseIp the routable IP to advertise in the LOCATION
 * @returns the response datagram text
 */
export function buildSearchResponse(device: RokuAdvert, advertiseIp: string): string {
  return [
    "HTTP/1.1 200 OK",
    `Cache-Control: max-age=${MAX_AGE}`,
    "ST: roku:ecp",
    `USN: uuid:roku:ecp:${device.uuid}`,
    "Ext: ",
    `Server: ${SERVER_SIG}`,
    `LOCATION: http://${advertiseIp}:${device.port}/`,
    "",
    "",
  ].join("\r\n");
}

/**
 * Build the proactive NOTIFY (ssdp:alive) datagram for one device, so controllers
 * find it without actively searching.
 *
 * @param device the emulated Roku
 * @param advertiseIp the routable IP to advertise in the LOCATION
 * @returns the NOTIFY datagram text
 */
export function buildAliveNotify(device: RokuAdvert, advertiseIp: string): string {
  return [
    "NOTIFY * HTTP/1.1",
    "Host: 239.255.255.250:1900",
    `Cache-Control: max-age=${MAX_AGE}`,
    `LOCATION: http://${advertiseIp}:${device.port}/`,
    "NT: roku:ecp",
    "NTS: ssdp:alive",
    `Server: ${SERVER_SIG}`,
    `USN: uuid:roku:ecp:${device.uuid}`,
    "",
    "",
  ].join("\r\n");
}
