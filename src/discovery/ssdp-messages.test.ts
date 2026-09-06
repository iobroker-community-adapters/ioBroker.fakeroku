import { buildAliveNotify, buildByebyeNotify, buildSearchResponse, rokuSearchTarget } from "./ssdp-messages";

const MSEARCH = [
  "M-SEARCH * HTTP/1.1",
  "Host: 239.255.255.250:1900",
  'MAN: "ssdp:discover"',
  "ST: roku:ecp",
  "MX: 3",
  "",
  "",
].join("\r\n");

describe("rokuSearchTarget", () => {
  it("accepts an M-SEARCH for roku:ecp", () => {
    expect(rokuSearchTarget(MSEARCH)).toBe("roku:ecp");
  });
  it("accepts ssdp:all", () => {
    expect(rokuSearchTarget(MSEARCH.replace("ST: roku:ecp", "ST: ssdp:all"))).toBe("ssdp:all");
  });
  it("accepts upnp:rootdevice (the generic UPnP sweep a controller may start with)", () => {
    expect(rokuSearchTarget(MSEARCH.replace("ST: roku:ecp", "ST: upnp:rootdevice"))).toBe("upnp:rootdevice");
  });
  it("rejects a foreign ST", () => {
    expect(rokuSearchTarget(MSEARCH.replace("ST: roku:ecp", "ST: urn:schemas-upnp-org:device:MediaRenderer:1"))).toBe(
      null,
    );
  });
  it("rejects a NOTIFY (not an M-SEARCH)", () => {
    expect(rokuSearchTarget(MSEARCH.replace("M-SEARCH * HTTP/1.1", "NOTIFY * HTTP/1.1"))).toBe(null);
  });
  it("rejects an M-SEARCH without ssdp:discover", () => {
    expect(rokuSearchTarget(MSEARCH.replace('MAN: "ssdp:discover"', "MAN: whatever"))).toBe(null);
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
  it("answers a wildcard search as the Roku service", () => {
    expect(buildSearchResponse({ uuid: "abc123", port: 8060 }, "10.47.88.2", "ssdp:all")).toContain("ST: roku:ecp");
  });
  it("mirrors a upnp:rootdevice search, because a control point drops an answer with a foreign ST", () => {
    const root = buildSearchResponse({ uuid: "abc123", port: 8060 }, "10.47.88.2", "upnp:rootdevice");
    expect(root).toContain("ST: upnp:rootdevice");
    // The USN keeps Roku's plain form even there — the `::<device>` suffix a strict UPnP
    // answer would carry is exactly what made node-ssdp unusable for this adapter.
    expect(root).toContain("USN: uuid:roku:ecp:abc123");
    expect(root).not.toContain("::");
  });
});

describe("buildAliveNotify", () => {
  const n = buildAliveNotify({ uuid: "abc123", port: 8060 }, "10.47.88.2");
  it("announces ssdp:alive with the Roku USN", () => {
    expect(n).toContain("NTS: ssdp:alive");
    expect(n).toContain("USN: uuid:roku:ecp:abc123");
  });
});

describe("buildByebyeNotify", () => {
  const n = buildByebyeNotify({ uuid: "abc123", port: 8060 });
  it("withdraws the device under the same identity it was announced with", () => {
    expect(n).toContain("NTS: ssdp:byebye");
    expect(n).toContain("NT: roku:ecp");
    expect(n).toContain("USN: uuid:roku:ecp:abc123");
  });
  it("carries no LOCATION — the device is gone, there is nothing left to fetch", () => {
    expect(n).not.toContain("LOCATION");
  });
});
