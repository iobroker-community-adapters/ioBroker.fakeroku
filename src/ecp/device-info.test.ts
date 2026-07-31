import { buildAppsXml, buildDescXml, buildDeviceInfoXml, DEFAULT_APPS } from "./device-info";

const device = { uuid: "abc123", port: 8060 };

describe("buildDeviceInfoXml", () => {
  const info = buildDeviceInfoXml(device, "Living Room", "player");
  it("advertises a current Roku OS version (the pairing lever, not 7.5.0)", () => {
    expect(info).toMatch(/<software-version>1[4-9]\.\d/);
  });
  it("carries the device identity as serial and udn", () => {
    expect(info).toContain("<serial-number>abc123</serial-number>");
    expect(info).toContain("<udn>abc123</udn>");
  });
  it("escapes the friendly name", () => {
    expect(buildDeviceInfoXml(device, "A & B", "player")).toContain("A &amp; B");
  });
  it("a player is not a TV and has no TV power/volume capability", () => {
    expect(info).toContain("<is-tv>false</is-tv>");
    expect(info).toContain("<model-name>Roku Ultra</model-name>");
    expect(info).toContain("<supports-tv-power-control>false</supports-tv-power-control>");
  });
  it("a TV advertises is-tv with power and volume capability", () => {
    const tv = buildDeviceInfoXml(device, "Living Room", "tv");
    expect(tv).toContain("<is-tv>true</is-tv>");
    expect(tv).toContain("<model-name>Roku TV</model-name>");
    expect(tv).toContain("<supports-tv-power-control>true</supports-tv-power-control>");
    expect(tv).toContain("<supports-audio-volume-control>true</supports-audio-volume-control>");
  });
});

describe("buildDescXml", () => {
  it("a player root description uses the player device type + ecp service + Roku USN", () => {
    const desc = buildDescXml(device, "Living Room", "player");
    expect(desc).toContain("urn:roku-com:device:player:1-0");
    expect(desc).toContain("urn:roku-com:service:ecp:1");
    expect(desc).toContain("<UDN>uuid:roku:ecp:abc123</UDN>");
  });
  it("a TV root description uses the tv device type", () => {
    expect(buildDescXml(device, "Living Room", "tv")).toContain("urn:roku-com:device:tv:1-0");
  });
});

describe("buildAppsXml", () => {
  it("renders configured apps and no dead 2015 services", () => {
    const apps = buildAppsXml(DEFAULT_APPS);
    expect(apps).toContain('<app id="12">Netflix</app>');
    expect(apps).not.toContain("Blockbuster");
  });
});
