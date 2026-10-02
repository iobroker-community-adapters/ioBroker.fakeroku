import {
  hasLocalAddress,
  inNet,
  listLocalNets,
  localAddressFor,
  netsOfInterface,
  pickMembershipIPv4s,
  pickPrimaryIPv4,
} from "./detect-ip";

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

describe("listLocalNets", () => {
  it("skips an interface the OS reports without addresses", () => {
    // os.networkInterfaces() types every entry as possibly undefined and does hand one out for
    // a down interface — iterating it directly throws at start-up.
    expect(listLocalNets({ down0: undefined, en0: [v4("192.168.1.5")] }).map(n => n.address)).toEqual(["192.168.1.5"]);
  });

  it("reads address, family and prefix of every non-internal entry", () => {
    expect(listLocalNets({ lo: [v4("127.0.0.1", 8, true)], eth0: [v4("192.168.1.5"), v6("2003:e1::5")] })).toEqual([
      { iface: "eth0", family: "IPv4", address: "192.168.1.5", prefixLength: 24 },
      { iface: "eth0", family: "IPv6", address: "2003:e1::5", prefixLength: 64 },
    ]);
  });

  it("takes a netmask Node could not turn into a prefix (cidr null) as the address alone", () => {
    // Node sets cidr to null only for a netmask that is not contiguous; there is no prefix to take.
    const nets = listLocalNets({
      eth0: [
        { address: "10.1.2.3", family: "IPv4", internal: false, netmask: "255.0.255.0", cidr: null } as never,
        { address: "fd00::1", family: "IPv6", internal: false, netmask: "ffff:0:ffff::", cidr: null } as never,
      ],
    });
    expect(nets.map(n => n.prefixLength)).toEqual([32, 128]);
  });

  it("drops a zone suffix, and counts an entry without a prefix as the address alone", () => {
    expect(
      listLocalNets({
        eth0: [
          { address: "fe80::1%eth0", family: "IPv6", internal: false, cidr: "fe80::1/64" } as never,
          { address: "10.0.0.1", family: "IPv4", internal: false } as never,
        ],
      }),
    ).toEqual([
      { iface: "eth0", family: "IPv6", address: "fe80::1", prefixLength: 64 },
      { iface: "eth0", family: "IPv4", address: "10.0.0.1", prefixLength: 32 },
    ]);
  });
});

describe("inNet", () => {
  const lan = { iface: "eth0", family: "IPv4" as const, address: "192.168.1.5", prefixLength: 24 };
  const v6net = {
    iface: "eth0",
    family: "IPv6" as const,
    address: "2003:e1:1f28:9a00::5",
    prefixLength: 64,
  };

  it("a /0 network takes every address (the shift by 32 would otherwise keep only the own one)", () => {
    expect(inNet("8.8.8.8", { ...lan, prefixLength: 0 })).toBe(true);
  });

  it("a malformed group outside the prefix still makes the address no address", () => {
    // Only the first 64 bits are compared: without the check the broken group would pass.
    expect(inNet("2003:e1:1f28:9a00:zzzz::1", v6net)).toBe(false);
  });

  it("matches an IPv4 address by prefix length", () => {
    expect(inNet("192.168.1.200", lan)).toBe(true);
    expect(inNet("192.168.2.1", lan)).toBe(false);
    expect(inNet("10.0.0.1", { ...lan, address: "10.200.0.1", prefixLength: 8 })).toBe(true);
    expect(inNet("anything", lan)).toBe(false);
  });

  it("matches an IPv6 address by prefix length, zone suffix and case ignored", () => {
    expect(inNet("2003:e1:1f28:9a00::42", v6net)).toBe(true);
    expect(inNet("2003:00E1:1F28:9A00::42%eth0", v6net)).toBe(true);
    expect(inNet("2003:e1:1f28:9a01::42", v6net)).toBe(false);
    expect(inNet("2003:e1:1f28:9a01::42", { ...v6net, prefixLength: 56 })).toBe(true);
  });

  it("a network in a form the subnet check refuses holds no address", () => {
    expect(inNet("192.168.1.5", { ...lan, prefixLength: 33 })).toBe(false);
    expect(inNet("192.168.1.5", { ...lan, address: "not-an-address" })).toBe(false);
  });

  it("a /32 and a /128 network hold the own address only", () => {
    expect(inNet("192.168.1.5", { ...lan, prefixLength: 32 })).toBe(true);
    expect(inNet("192.168.1.6", { ...lan, prefixLength: 32 })).toBe(false);
    expect(inNet("2003:e1:1f28:9a00::5", { ...v6net, prefixLength: 128 })).toBe(true);
    expect(inNet("2003:e1:1f28:9a00::6", { ...v6net, prefixLength: 128 })).toBe(false);
  });

  it("takes an IPv4-mapped address for the IPv4 address it carries", () => {
    expect(inNet("::ffff:192.168.1.77", lan)).toBe(true);
    expect(inNet("::ffff:192.168.2.77", lan)).toBe(false);
  });

  it("ignores a zone suffix on the network's own address", () => {
    expect(inNet("fe80::2", { ...v6net, address: "fe80::1%en0", prefixLength: 64 })).toBe(true);
  });

  it("refuses a malformed IPv6 value instead of guessing", () => {
    for (const bad of [
      "2003:::1",
      "2003::1::2",
      "2003:e1:zzzz:9a00::1",
      "not-an-address",
      "::ffff:10.0.0.1",
      // "::" stands for at least one zero group — with eight groups around it, it stands for none.
      "2003:e1:1f28:9a00:1:2:3::4",
    ]) {
      expect(inNet(bad, v6net), bad).toBe(false);
    }
  });
});

describe("the host's own networks", () => {
  const nets = listLocalNets({
    eth0: [v4("10.47.88.2")],
    "eth0.50": [v4("192.168.50.2")],
    docker0: [v4("172.17.0.1", 16)],
  });

  it("finds the host's address in the network a remote sits in", () => {
    expect(localAddressFor("192.168.50.77", nets)).toBe("192.168.50.2");
    expect(localAddressFor("::ffff:10.47.88.99", nets)).toBe("10.47.88.2");
    expect(localAddressFor("8.8.8.8", nets)).toBeUndefined();
  });

  it("knows which addresses the host carries", () => {
    expect(hasLocalAddress("192.168.50.2", nets)).toBe(true);
    expect(hasLocalAddress("192.168.50.3", nets)).toBe(false);
  });

  it("narrows to the networks of the interface that carries an address", () => {
    expect(netsOfInterface("192.168.50.2", nets).map(n => n.address)).toEqual(["192.168.50.2"]);
    expect(netsOfInterface("1.2.3.4", nets)).toEqual([]);
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
