// Guard of F-04 (krobi 2026-09-03 08:52, "dann mach das so, bau es ein"): fakeroku takes commands and searches only from
// its own networks — over IPv6 too, with an address from the own network; everything else stays out. Sealed in the
// register — a change goes through the Werkbank.
import { describe, expect, it } from "vitest";
import { isOwnPeer, type LocalNet } from "../lib/network-address";

// A host in 192.168.1.0/24 with a provider IPv6 prefix and a ULA prefix.
const home: LocalNet[] = [
  { iface: "eth0", family: "IPv4", address: "192.168.1.5", prefixLength: 24 },
  { iface: "eth0", family: "IPv6", address: "2003:e1:1f28:9a00::5", prefixLength: 64 },
  { iface: "eth0", family: "IPv6", address: "fd12:3456:789a::5", prefixLength: 64 },
];

describe("F-04 — only clients from the own networks, IPv6 with an own-network address included", () => {
  it("answers a client from the own network over IPv4 and IPv6", () => {
    for (const peer of ["192.168.1.77", "::ffff:192.168.1.77", "2003:e1:1f28:9a00::42", "fd12:3456:789a::1"]) {
      expect(isOwnPeer(peer, undefined, home), peer).toBe(true);
    }
  });

  it("keeps out a client from any other network", () => {
    for (const peer of ["8.8.8.8", "10.47.88.5", "192.168.2.10", "2003:e1:1f28:9a01::42", "fd7a:115c:a1e0::1"]) {
      expect(isOwnPeer(peer, undefined, home), peer).toBe(false);
    }
    expect(isOwnPeer(undefined, undefined, home)).toBe(false);
  });
});
