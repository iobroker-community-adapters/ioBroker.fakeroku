import { ipv6Prefix64, listLocalIPv6Prefixes, listNonInternalIPv4s, pickPrimaryIPv4 } from "./detect-ip";

describe("pickPrimaryIPv4", () => {
  it("returns the first non-internal IPv4 (skips loopback)", () => {
    expect(
      pickPrimaryIPv4({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        eth0: [{ address: "10.47.88.2", family: "IPv4", internal: false }],
      } as never),
    ).toBe("10.47.88.2");
  });

  it("skips internal addresses and IPv6", () => {
    expect(
      pickPrimaryIPv4({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        eth0: [{ address: "fe80::1", family: "IPv6", internal: false }],
      } as never),
    ).toBe("");
  });

  it("returns empty string when there are no interfaces", () => {
    expect(pickPrimaryIPv4({})).toBe("");
  });

  it("skips Docker's default bridges in favour of the real LAN address", () => {
    // An ioBroker host commonly runs Docker, and docker0 can come first in the
    // enumeration. Advertising 172.17.0.1 puts an unreachable address into every
    // SSDP answer while the adapter looks perfectly healthy.
    expect(
      pickPrimaryIPv4({
        docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
        br_compose: [{ address: "172.18.0.1", family: "IPv4", internal: false }],
        eth0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
      } as never),
    ).toBe("192.168.1.20");
  });

  it("still advertises a bridge address when the host has nothing else", () => {
    // Inside a container that IS on the bridge network, that address is all there
    // is — an empty answer would stop the adapter for no reason.
    expect(
      pickPrimaryIPv4({
        eth0: [{ address: "172.17.0.5", family: "IPv4", internal: false }],
      } as never),
    ).toBe("172.17.0.5");
  });

  it("keeps the rest of 172.16.0.0/12, which is ordinary private space", () => {
    // Only 172.17/172.18 are Docker's defaults; 172.16.x.x and 172.20.x.x are
    // perfectly normal LANs and must not be pushed to the back.
    expect(
      pickPrimaryIPv4({
        eth0: [{ address: "172.16.5.4", family: "IPv4", internal: false }],
        eth1: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
      } as never),
    ).toBe("172.16.5.4");
  });
});

describe("listNonInternalIPv4s", () => {
  it("skips an interface the OS reports without addresses", () => {
    // os.networkInterfaces() types every entry as possibly undefined and does hand
    // one out for a down interface — iterating it directly throws at start-up.
    expect(
      listNonInternalIPv4s({
        down0: undefined,
        en0: [{ address: "192.168.1.5", family: "IPv4", internal: false }],
      } as never),
    ).toEqual(["192.168.1.5"]);
  });

  it("returns every non-internal IPv4 across interfaces, in enumeration order", () => {
    expect(
      listNonInternalIPv4s({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        eth0: [{ address: "10.47.88.2", family: "IPv4", internal: false }],
        wlan0: [{ address: "192.168.1.5", family: "IPv4", internal: false }],
      } as never),
    ).toEqual(["10.47.88.2", "192.168.1.5"]);
  });

  it("skips loopback and IPv6", () => {
    expect(
      listNonInternalIPv4s({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        eth0: [
          { address: "fe80::1", family: "IPv6", internal: false },
          { address: "10.0.0.9", family: "IPv4", internal: false },
        ],
      } as never),
    ).toEqual(["10.0.0.9"]);
  });

  it("returns an empty list when nothing is routable", () => {
    expect(listNonInternalIPv4s({ lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }] } as never)).toEqual(
      [],
    );
  });
});

describe("ipv6Prefix64", () => {
  it("takes the first four groups, zero-padded", () => {
    expect(ipv6Prefix64("2003:e1:1f28:9a00:1234:5678:9abc:def0")).toBe("2003:00e1:1f28:9a00");
  });

  it("expands the :: shorthand in every position", () => {
    expect(ipv6Prefix64("2003:e1:1f28:9a00::42")).toBe("2003:00e1:1f28:9a00");
    expect(ipv6Prefix64("::1")).toBe("0000:0000:0000:0000");
    expect(ipv6Prefix64("fe80::")).toBe("fe80:0000:0000:0000");
  });

  it("drops a zone suffix and normalises case", () => {
    expect(ipv6Prefix64("FE80::1%eth0")).toBe("fe80:0000:0000:0000");
  });

  it("returns null for anything that is not a plain IPv6 address", () => {
    expect(ipv6Prefix64("192.168.1.5")).toBeNull();
    expect(ipv6Prefix64("::ffff:192.168.1.5")).toBeNull();
    expect(ipv6Prefix64("2003:::1")).toBeNull();
    // Two "::" in one address — the shorthand may appear at most once.
    expect(ipv6Prefix64("2003::1::2")).toBeNull();
    expect(ipv6Prefix64("2003:e1:1f28")).toBeNull();
    expect(ipv6Prefix64("2003:e1:1f28:9a00:1:2:3:4:5")).toBeNull();
    expect(ipv6Prefix64("2003:e1:zzzz:9a00::1")).toBeNull();
    expect(ipv6Prefix64("")).toBeNull();
  });
});

describe("listLocalIPv6Prefixes", () => {
  it("collects the prefixes of the non-internal IPv6 addresses, de-duplicated", () => {
    const prefixes = listLocalIPv6Prefixes({
      lo: [{ address: "::1", family: "IPv6", internal: true } as never],
      eth0: [
        { address: "192.168.1.5", family: "IPv4", internal: false } as never,
        { address: "2003:e1:1f28:9a00::5", family: "IPv6", internal: false } as never,
        // A second address in the same network (a temporary privacy address).
        { address: "2003:e1:1f28:9a00:dead:beef:1:2", family: "IPv6", internal: false } as never,
        { address: "fe80::1", family: "IPv6", internal: false } as never,
      ],
    });
    expect(prefixes).toEqual(["2003:00e1:1f28:9a00", "fe80:0000:0000:0000"]);
  });

  it("survives an interface entry the OS left empty", () => {
    // os.networkInterfaces() types the entries as possibly undefined.
    expect(listLocalIPv6Prefixes({ eth0: undefined, wlan0: [] })).toEqual([]);
  });

  it("skips an address it cannot parse instead of inventing a prefix", () => {
    expect(
      listLocalIPv6Prefixes({
        eth0: [
          { address: "2003::1::2", family: "IPv6", internal: false } as never,
          { address: "2003:e1:1f28:9a00::5", family: "IPv6", internal: false } as never,
        ],
      }),
    ).toEqual(["2003:00e1:1f28:9a00"]);
  });

  it("is empty on a host without IPv6", () => {
    expect(
      listLocalIPv6Prefixes({ eth0: [{ address: "192.168.1.5", family: "IPv4", internal: false } as never] }),
    ).toEqual([]);
  });
});
