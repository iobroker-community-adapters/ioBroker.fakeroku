import { localAddressFor, pickMembershipIPv4s, pickPrimaryIPv4 } from "./detect-ip";
import { localNets } from "./network-address";

/**
 * One IPv4 entry the way os.networkInterfaces() reports it.
 *
 * @param address the address
 * @param prefix the prefix length
 * @param internal loopback or not
 */
function v4(address: string, prefix = 24, internal = false): never {
  return { address, family: "IPv4", internal, cidr: `${address}/${prefix}` } as never;
}

/**
 * One IPv6 entry the way os.networkInterfaces() reports it.
 *
 * @param address the address
 * @param prefix the prefix length
 */
function v6(address: string, prefix = 64): never {
  return { address, family: "IPv6", internal: false, cidr: `${address}/${prefix}` } as never;
}

describe("pickPrimaryIPv4", () => {
  it("returns the first non-internal IPv4 (skips loopback)", () => {
    expect(pickPrimaryIPv4({ lo: [v4("127.0.0.1", 8, true)], eth0: [v4("10.47.88.2")] })).toBe("10.47.88.2");
  });

  it("skips internal addresses and IPv6", () => {
    expect(pickPrimaryIPv4({ lo: [v4("127.0.0.1", 8, true)], eth0: [v6("fe80::1")] })).toBe("");
  });

  it("returns empty string when there are no interfaces", () => {
    expect(pickPrimaryIPv4({})).toBe("");
  });

  it("takes the first IPv4 the host enumerates, a bridge included — no interface is filtered by its name", () => {
    expect(pickPrimaryIPv4({ docker0: [v4("172.17.0.1", 16)], eth0: [v4("192.168.1.20")] })).toBe("172.17.0.1");
  });

  it("keeps a real interface in 172.16.0.0/12 — ordinary private space", () => {
    expect(pickPrimaryIPv4({ eth0: [v4("172.16.5.4")], eth1: [v4("192.168.1.20")] })).toBe("172.16.5.4");
    expect(pickPrimaryIPv4({ eth0: [v4("172.20.5.4")], eth1: [v4("192.168.1.20")] })).toBe("172.20.5.4");
  });
});

describe("localAddressFor — the host's address in a remote's network", () => {
  const nets = localNets({
    eth0: [v4("10.47.88.2")],
    "eth0.50": [v4("192.168.50.2")],
    docker0: [v4("172.17.0.1", 16)],
  });

  it("finds the host's address in the network a remote sits in", () => {
    expect(localAddressFor("192.168.50.77", nets)).toBe("192.168.50.2");
    expect(localAddressFor("::ffff:10.47.88.99", nets)).toBe("10.47.88.2");
    expect(localAddressFor("172.17.0.9", nets)).toBe("172.17.0.1");
    expect(localAddressFor("8.8.8.8", nets)).toBeUndefined();
  });
});

describe("pickMembershipIPv4s", () => {
  it("joins every real LAN interface, once per interface", () => {
    // A membership belongs to the interface: a second address on the same card would join it
    // again and throw EADDRINUSE.
    expect(
      pickMembershipIPv4s({
        eth0: [v4("10.47.88.2"), v4("10.47.88.3")],
        eth1: [v4("192.168.1.5")],
        lo: [v4("127.0.0.1", 8, true)],
      }),
    ).toEqual([
      { iface: "eth0", address: "10.47.88.2" },
      { iface: "eth1", address: "192.168.1.5" },
    ]);
  });

  it("joins a bridge like every other interface — a search from its network gets that network's address", () => {
    expect(
      pickMembershipIPv4s({
        docker0: [v4("172.17.0.1", 16)],
        eth0: [v4("10.47.88.2")],
      }),
    ).toEqual([
      { iface: "docker0", address: "172.17.0.1" },
      { iface: "eth0", address: "10.47.88.2" },
    ]);
  });
});
