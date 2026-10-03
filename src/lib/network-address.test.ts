// Fleet master (.consistency-master/src/lib/network-address.test.ts) — never edit the copy in an adapter.
import { describe, expect, it } from "vitest";
import { networkInterfaces } from "node:os";
import { carriesAddress, chosenAddress, isOwnPeer, localNets, ownNets, type InterfaceMap } from "./network-address";

const IFACES: InterfaceMap = {
  lo0: [
    {
      address: "127.0.0.1",
      netmask: "255.0.0.0",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: true,
      cidr: "127.0.0.1/8",
    },
  ],
  eth0: [
    {
      address: "192.168.1.5",
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "aa:aa:aa:aa:aa:aa",
      internal: false,
      cidr: "192.168.1.5/24",
    },
    {
      address: "2001:db8::5",
      netmask: "ffff:ffff:ffff:ffff::",
      family: "IPv6",
      mac: "aa:aa:aa:aa:aa:aa",
      internal: false,
      cidr: "2001:db8::5/64",
      scopeid: 0,
    },
  ],
  iot: [
    {
      address: "10.47.88.2",
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "bb:bb:bb:bb:bb:bb",
      internal: false,
      cidr: null,
    },
    {
      address: "FE80::1%iot",
      netmask: "ffff:ffff:ffff:ffff::",
      family: "IPv6",
      mac: "bb:bb:bb:bb:bb:bb",
      internal: false,
      cidr: null,
      scopeid: 3,
    },
  ],
  odd: [{ address: "x", netmask: "x", family: "IPX" as "IPv4", mac: "", internal: false, cidr: null }],
  none: undefined,
};

describe("chosenAddress", () => {
  it("reads every wildcard and the empty value as every address", () => {
    for (const value of ["", "  ", "0.0.0.0", " :: ", undefined, null, 42]) {
      expect(chosenAddress(value)).toBeUndefined();
    }
  });

  it("keeps a chosen address, trimmed", () => {
    expect(chosenAddress(" 192.168.1.5 ")).toBe("192.168.1.5");
  });
});

describe("localNets", () => {
  it("lists every network but loopback, with the prefix from cidr or the address alone", () => {
    expect(localNets(IFACES)).toEqual([
      { iface: "eth0", family: "IPv4", address: "192.168.1.5", prefixLength: 24 },
      { iface: "eth0", family: "IPv6", address: "2001:db8::5", prefixLength: 64 },
      { iface: "iot", family: "IPv4", address: "10.47.88.2", prefixLength: 32 },
      { iface: "iot", family: "IPv6", address: "fe80::1", prefixLength: 128 },
    ]);
  });

  it("reads the host's own interfaces when given none", () => {
    const own = Object.values(networkInterfaces())
      .flat()
      .filter(i => i && !i.internal).length;
    expect(localNets().length).toBe(own);
  });
});

describe("carriesAddress", () => {
  const nets = localNets(IFACES);

  it("knows the host's own addresses, an IPv6 one with or without zone and case", () => {
    expect(carriesAddress("192.168.1.5", nets)).toBe(true);
    expect(carriesAddress("FE80::1%iot", nets)).toBe(true);
  });

  it("does not know an address no interface carries, loopback included", () => {
    expect(carriesAddress("192.0.2.1", nets)).toBe(false);
    expect(carriesAddress("127.0.0.1", nets)).toBe(false);
  });

  it("reads the host's own interfaces when given none", () => {
    expect(carriesAddress("192.0.2.1")).toBe(false);
  });
});

describe("ownNets", () => {
  const nets = localNets(IFACES);

  it("is every network with every address", () => {
    expect(ownNets(undefined, nets)).toEqual(nets);
  });

  it("is the networks of the chosen address's interface", () => {
    expect(ownNets("192.168.1.5", nets).map(n => n.address)).toEqual(["192.168.1.5", "2001:db8::5"]);
    expect(ownNets("fe80::1%iot", nets).map(n => n.address)).toEqual(["10.47.88.2", "fe80::1"]);
  });

  it("is nothing for an address no interface carries", () => {
    expect(ownNets("192.0.2.1", nets)).toEqual([]);
  });

  it("reads the host's own interfaces when given none", () => {
    expect(ownNets(undefined)).toEqual(localNets());
  });
});

describe("isOwnPeer", () => {
  const nets = localNets(IFACES);

  it("answers a peer in the chosen network, IPv4, IPv4-mapped and IPv6", () => {
    expect(isOwnPeer("192.168.1.77", "192.168.1.5", nets)).toBe(true);
    expect(isOwnPeer("::FFFF:192.168.1.77", "192.168.1.5", nets)).toBe(true);
    expect(isOwnPeer("2001:db8::77", "192.168.1.5", nets)).toBe(true);
  });

  it("answers no peer outside the chosen network — another own network, loopback, nothing", () => {
    expect(isOwnPeer("10.47.88.2", "192.168.1.5", nets)).toBe(false);
    expect(isOwnPeer("127.0.0.1", "192.168.1.5", nets)).toBe(false);
    expect(isOwnPeer(undefined, "192.168.1.5", nets)).toBe(false);
    expect(isOwnPeer("", undefined, nets)).toBe(false);
  });

  it("answers a peer of any own network with every address, and nothing outside", () => {
    expect(isOwnPeer("10.47.88.2", undefined, nets)).toBe(true);
    expect(isOwnPeer("fe80::1%iot", undefined, nets)).toBe(true);
    expect(isOwnPeer("10.47.4.9", undefined, nets)).toBe(false);
  });

  it("answers no peer in a form that is no IP address", () => {
    expect(isOwnPeer("not an address", undefined, nets)).toBe(false);
  });

  it("refuses a network the check cannot take", () => {
    expect(isOwnPeer("1.2.3.4", undefined, [{ iface: "x", family: "IPv4", address: "nope", prefixLength: 8 }])).toBe(
      false,
    );
  });

  it("reads the host's own interfaces when given none", () => {
    expect(isOwnPeer("192.0.2.77", undefined)).toBe(false);
  });
});
