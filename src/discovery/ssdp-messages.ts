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

/** The search targets this responder answers. */
const ANSWERED_TARGETS = ["roku:ecp", "ssdp:all", "upnp:rootdevice"] as const;

/** One search target a controller can ask for. */
export type SearchTarget = (typeof ANSWERED_TARGETS)[number];

/**
 * The search target of an M-SEARCH a Roku should answer, or null if this datagram is not
 * one. Requires the M-SEARCH request line, `MAN: "ssdp:discover"`, and an ST of roku:ecp /
 * ssdp:all / upnp:rootdevice.
 *
 * The target is returned rather than a bare boolean because the answer has to name what was
 * searched for: a control point that asked for `upnp:rootdevice` discards a response whose
 * `ST` says something else (UPnP 1.1, 1.3.3). Harmony and Sofabaton search `roku:ecp`, so
 * that path is unaffected either way.
 *
 * @param message the raw datagram text
 * @returns the search target, or null if no response is warranted
 */
export function rokuSearchTarget(message: string): SearchTarget | null {
  if (!/^M-SEARCH \* HTTP\/1\.1/im.test(message)) {
    return null;
  }
  if (!/^MAN:\s*"ssdp:discover"/im.test(message)) {
    return null;
  }
  const st = message.match(/^ST:\s*(.+?)\s*$/im)?.[1];
  return ANSWERED_TARGETS.find(target => target === st) ?? null;
}

/**
 * Build the SSDP 200-OK response for one emulated Roku, in Roku's exact format
 * (USN without the node-ssdp `::device` suffix), advertising the given IP.
 *
 * `ST` mirrors what the controller searched for; a wildcard `ssdp:all` is answered as the
 * Roku service, which is the only thing this responder is. The USN stays the plain identity
 * in every case — that is Roku's format, and the `::<device>` suffix a strict UPnP answer
 * would carry is exactly what made node-ssdp unusable here.
 *
 * @param device the emulated Roku
 * @param advertiseIp the routable IP to advertise in the LOCATION
 * @param target the search target to answer as (defaults to the Roku service)
 * @returns the response datagram text
 */
export function buildSearchResponse(
  device: RokuAdvert,
  advertiseIp: string,
  target: SearchTarget = "roku:ecp",
): string {
  return [
    "HTTP/1.1 200 OK",
    `Cache-Control: max-age=${MAX_AGE}`,
    `ST: ${target === "upnp:rootdevice" ? "upnp:rootdevice" : "roku:ecp"}`,
    `USN: uuid:roku:ecp:${device.uuid}`,
    "Ext: ",
    `Server: ${SERVER_SIG}`,
    `LOCATION: http://${advertiseIp}:${device.port}/`,
    "",
    "",
  ].join("\r\n");
}

/**
 * Build the `ssdp:byebye` datagram for one device — the farewell a controller needs to drop
 * the emulated Roku from its list. Without it the device stays discoverable for the
 * announced `max-age` (an hour) after the instance stopped, and a remote keeps sending key
 * presses to a port nobody serves.
 *
 * @param device the emulated Roku
 * @returns the NOTIFY datagram text
 */
export function buildByebyeNotify(device: RokuAdvert): string {
  return [
    "NOTIFY * HTTP/1.1",
    "Host: 239.255.255.250:1900",
    "NT: roku:ecp",
    "NTS: ssdp:byebye",
    `USN: uuid:roku:ecp:${device.uuid}`,
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
