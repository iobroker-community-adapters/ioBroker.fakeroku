import { buildAliveNotify, buildSearchResponse, matchesRokuSearch } from "./ssdp-messages";

const MSEARCH = [
  "M-SEARCH * HTTP/1.1",
  "Host: 239.255.255.250:1900",
  'MAN: "ssdp:discover"',
  "ST: roku:ecp",
  "MX: 3",
  "",
  "",
].join("\r\n");

describe("matchesRokuSearch", () => {
  it("accepts an M-SEARCH for roku:ecp", () => {
    expect(matchesRokuSearch(MSEARCH)).toBe(true);
  });
  it("accepts ssdp:all", () => {
    expect(matchesRokuSearch(MSEARCH.replace("ST: roku:ecp", "ST: ssdp:all"))).toBe(true);
  });
  it("rejects a foreign ST", () => {
    expect(matchesRokuSearch(MSEARCH.replace("ST: roku:ecp", "ST: urn:schemas-upnp-org:device:MediaRenderer:1"))).toBe(
      false,
    );
  });
  it("rejects a NOTIFY (not an M-SEARCH)", () => {
    expect(matchesRokuSearch(MSEARCH.replace("M-SEARCH * HTTP/1.1", "NOTIFY * HTTP/1.1"))).toBe(false);
  });
  it("rejects an M-SEARCH without ssdp:discover", () => {
    expect(matchesRokuSearch(MSEARCH.replace('MAN: "ssdp:discover"', "MAN: whatever"))).toBe(false);
  });
});

describe("buildSearchResponse", () => {
  const r = buildSearchResponse({ uuid: "abc123", port: 8060 }, "10.47.88.2");
  it("uses Roku's USN format", () => {
    expect(r).toContain("USN: uuid:roku:ecp:abc123");
  });
  it("has NO ::device suffix (the node-ssdp trap)", () => {
    expect(r).not.toContain("::");
  });
  it("advertises the selected interface IP and port", () => {
    expect(r).toContain("LOCATION: http://10.47.88.2:8060/");
  });
  it("answers with ST roku:ecp", () => {
    expect(r).toContain("ST: roku:ecp");
  });
});

describe("buildAliveNotify", () => {
  const n = buildAliveNotify({ uuid: "abc123", port: 8060 }, "10.47.88.2");
  it("announces ssdp:alive with the Roku USN", () => {
    expect(n).toContain("NTS: ssdp:alive");
    expect(n).toContain("USN: uuid:roku:ecp:abc123");
  });
});
