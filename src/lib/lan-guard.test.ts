import type { LocalNet } from "./detect-ip";
import { isLanClient } from "./lan-guard";

/**
 * A network of the host.
 *
 * @param address the host's address in it
 * @param prefixLength the prefix length
 * @param iface the interface name
 */
function net(address: string, prefixLength: number, iface = "eth0"): LocalNet {
  return { iface, family: address.includes(":") ? "IPv6" : "IPv4", address, prefixLength, virtual: false };
}

// A host in 192.168.1.0/24 with native IPv6 (2003:e1:1f28:9a00::/64) and a ULA prefix.
const home = (): LocalNet[] => [net("192.168.1.5", 24), net("2003:e1:1f28:9a00::5", 64), net("fd12:3456:789a::5", 64)];

describe("isLanClient — only the host's own networks", () => {
  it("accepts a client in one of the host's networks", () => {
    for (const ip of ["192.168.1.10", "::ffff:192.168.1.10", "2003:e1:1f28:9a00::42", "fd12:3456:789a::1"]) {
      expect(isLanClient(ip, home), ip).toBe(true);
    }
  });

  it("refuses a private address that is NOT one of the host's networks", () => {
    // Another VLAN, a VPN: private address space, but not this host's network. Tailscale hands out
    // 100.64/10 over IPv4 and fd7a:115c:a1e0::/48 over IPv6 — neither is a network of the host.
    for (const ip of ["10.47.88.5", "172.16.0.1", "192.168.2.10", "100.64.0.1", "fd7a:115c:a1e0::1", "fc00::1"]) {
      expect(isLanClient(ip, home), ip).toBe(false);
    }
  });

  it("refuses public addresses, a global IPv6 from another prefix, and nothing", () => {
    for (const ip of ["8.8.8.8", "2003:e1:1f28:9a01::42", "2001:4860:4860::8888", "not-an-address", "2003:::1"]) {
      expect(isLanClient(ip, home), ip).toBe(false);
    }
    expect(isLanClient(undefined, home)).toBe(false);
  });

  it("accepts loopback and link-local without asking for the networks", () => {
    // A link-local address is on the same wire by definition — 169.254 is what a remote
    // self-assigns when the DHCP server is slow or gone, exactly when the user troubleshoots.
    const boom = (): LocalNet[] => {
      throw new Error("must not be asked for loopback or link-local");
    };
    for (const ip of ["127.0.0.1", "::1", "169.254.10.5", "fe80::1", "FE80::A1B2:C3D4%en0", "::ffff:127.0.0.1"]) {
      expect(isLanClient(ip, boom), ip).toBe(true);
    }
  });

  it("with a chosen interface, only that interface's network counts", () => {
    const chosen = (): LocalNet[] => [net("192.168.50.2", 24, "eth0.50")];
    expect(isLanClient("192.168.50.77", chosen)).toBe(true);
    expect(isLanClient("192.168.1.10", chosen)).toBe(false);
  });

  it("refuses everything routable when the host has no network at all", () => {
    expect(isLanClient("192.168.1.10", () => [])).toBe(false);
  });
});
