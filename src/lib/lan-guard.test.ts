import { isLanClient } from "./lan-guard";

describe("isLanClient", () => {
  it("accepts private ranges and localhost", () => {
    for (const ip of ["10.47.88.5", "192.168.1.10", "172.16.0.1", "172.31.255.1", "127.0.0.1", "::1"]) {
      expect(isLanClient(ip)).toBe(true);
    }
  });
  it("accepts a link-local address (a remote that got no DHCP lease)", () => {
    // 169.254/16 is what a controller self-assigns when the DHCP server is slow or
    // gone. It is still on the wire in the same LAN — rejecting it locks the user's
    // remote out exactly in the situation they are already troubleshooting.
    expect(isLanClient("169.254.10.5")).toBe(true);
  });

  it("accepts IPv6-mapped private IPv4", () => {
    expect(isLanClient("::ffff:10.47.88.5")).toBe(true);
  });
  it("rejects public IPs, the 172.32 boundary, and undefined", () => {
    expect(isLanClient("8.8.8.8")).toBe(false);
    expect(isLanClient("172.32.0.1")).toBe(false);
    expect(isLanClient(undefined)).toBe(false);
  });

  it("accepts IPv6 link-local and unique-local clients (an IPv6-only LAN segment)", () => {
    for (const ip of ["fe80::1", "fe80::a1b2:c3d4%en0", "FE80::1", "fd12:3456:789a::1", "fc00::1"]) {
      expect(isLanClient(ip), ip).toBe(true);
    }
  });
  it("rejects global IPv6 and the ranges next to the local ones", () => {
    for (const ip of ["2001:db8::1", "fe00::1", "fec0::1", "ff02::1"]) {
      expect(isLanClient(ip), ip).toBe(false);
    }
  });

  it("rejects addresses that merely start with the same digits", () => {
    // 100.64/10 is carrier-grade NAT — public-side address space, not a LAN.
    // A prefix match on "10" instead of "10." would hand the whole range access.
    expect(isLanClient("100.64.0.1")).toBe(false);
    expect(isLanClient("109.1.2.3")).toBe(false);
    expect(isLanClient("1.2.3.4")).toBe(false);
  });
});

describe("isLanClient — globally routable IPv6", () => {
  // On a connection with native IPv6 every device in the house carries an address
  // out of the provider's block. It looks like an internet address; only the /64
  // prefix says whether it is on the same link.
  const own = (): string[] => ["2003:00e1:1f28:9a00", "2a02:0908:1234:5600"];

  it("accepts a remote in the host's own /64", () => {
    expect(isLanClient("2003:e1:1f28:9a00::42", own)).toBe(true);
    expect(isLanClient("2003:00e1:1f28:9a00:1234:5678:9abc:def0", own)).toBe(true);
    expect(isLanClient("2a02:908:1234:5600:0:0:0:1", own)).toBe(true);
  });

  it("still refuses a global address from a different /64", () => {
    // One group different is a different network — that is the internet.
    expect(isLanClient("2003:e1:1f28:9a01::42", own)).toBe(false);
    expect(isLanClient("2001:4860:4860::8888", own)).toBe(false);
  });

  it("refuses everything global when the host has no IPv6 of its own", () => {
    expect(isLanClient("2003:e1:1f28:9a00::42", () => [])).toBe(false);
  });

  it("keeps the link-local and unique-local answers without consulting the host", () => {
    const boom = (): string[] => {
      throw new Error("must not be asked for a link-local or unique-local client");
    };
    expect(isLanClient("fe80::1%eth0", boom)).toBe(true);
    expect(isLanClient("fd12:3456:789a::1", boom)).toBe(true);
    expect(isLanClient("192.168.1.5", boom)).toBe(true);
    expect(isLanClient("::ffff:10.0.0.4", boom)).toBe(true);
  });

  it("matches a zone suffix and mixed case against the prefix", () => {
    expect(isLanClient("2003:00E1:1F28:9A00::42%eth0", own)).toBe(true);
  });

  it("refuses a malformed IPv6 value instead of guessing", () => {
    expect(isLanClient("2003:::1", own)).toBe(false);
    expect(isLanClient("not-an-address", own)).toBe(false);
    expect(isLanClient("2003:e1:zzzz:9a00::1", own)).toBe(false);
  });
});
