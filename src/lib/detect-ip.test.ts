import { listNonInternalIPv4s, pickPrimaryIPv4 } from "./detect-ip";

describe("pickPrimaryIPv4", () => {
  it("returns the first non-internal IPv4 (skips loopback)", () => {
    expect(
      pickPrimaryIPv4({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        eth0: [{ address: "10.47.88.2", family: "IPv4", internal: false }],
      } as never),
    ).toBe("10.47.88.2");
  });

  it("accepts the numeric family shape (Node 18+)", () => {
    expect(
      pickPrimaryIPv4({
        eth0: [{ address: "192.168.1.5", family: 4, internal: false }],
      } as never),
    ).toBe("192.168.1.5");
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
});

describe("listNonInternalIPv4s", () => {
  it("returns every non-internal IPv4 across interfaces, in enumeration order", () => {
    expect(
      listNonInternalIPv4s({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        eth0: [{ address: "10.47.88.2", family: "IPv4", internal: false }],
        wlan0: [{ address: "192.168.1.5", family: 4, internal: false }],
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
    expect(
      listNonInternalIPv4s({ lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }] } as never),
    ).toEqual([]);
  });
});
