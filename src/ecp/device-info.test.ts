import { buildAppsXml, buildDescXml, buildDeviceInfoXml, DEFAULT_APPS } from "./device-info";

const device = { uuid: "abc123", port: 8060 };

describe("buildDeviceInfoXml", () => {
  const info = buildDeviceInfoXml(device, "Living Room");
  it("advertises a current Roku OS version (the pairing lever, not 7.5.0)", () => {
    expect(info).toMatch(/<software-version>1[4-9]\.\d/);
  });
  it("carries the device identity as serial and udn", () => {
    expect(info).toContain("<serial-number>abc123</serial-number>");
    expect(info).toContain("<udn>abc123</udn>");
  });
  it("escapes the friendly name", () => {
    expect(buildDeviceInfoXml(device, "A & B")).toContain("A &amp; B");
  });
});

describe("buildDescXml", () => {
  it("is a Roku player root description with the ecp service and Roku USN", () => {
    const desc = buildDescXml(device, "Living Room");
    expect(desc).toContain("urn:roku-com:device:player:1-0");
    expect(desc).toContain("urn:roku-com:service:ecp:1");
    expect(desc).toContain("<UDN>uuid:roku:ecp:abc123</UDN>");
  });
});

describe("buildAppsXml", () => {
  it("renders configured apps and no dead 2015 services", () => {
    const apps = buildAppsXml(DEFAULT_APPS);
    expect(apps).toContain('<app id="12">Netflix</app>');
    expect(apps).not.toContain("Blockbuster");
  });
});
