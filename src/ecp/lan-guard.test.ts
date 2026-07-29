import { isLanClient } from "./lan-guard";

describe("isLanClient", () => {
  it("accepts private ranges and localhost", () => {
    for (const ip of ["10.47.88.5", "192.168.1.10", "172.16.0.1", "172.31.255.1", "127.0.0.1", "::1"]) {
      expect(isLanClient(ip)).toBe(true);
    }
  });
  it("accepts IPv6-mapped private IPv4", () => {
    expect(isLanClient("::ffff:10.47.88.5")).toBe(true);
  });
  it("rejects public IPs, the 172.32 boundary, and undefined", () => {
    expect(isLanClient("8.8.8.8")).toBe(false);
    expect(isLanClient("172.32.0.1")).toBe(false);
    expect(isLanClient(undefined)).toBe(false);
  });
});
