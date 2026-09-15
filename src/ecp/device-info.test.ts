import { buildAppsXml, buildDescXml, buildDeviceInfoXml, DEFAULT_APPS, SOFTWARE_VERSION } from "./device-info";

const device = { uuid: "abc123", port: 8060 };

describe("buildDeviceInfoXml", () => {
  const info = buildDeviceInfoXml(device, "Living Room", "player");
  it("advertises exactly the version the module declares, and never an older major", () => {
    // Two separate rules, and the old `1[4-9]\.` regex got both wrong: it would go red on
    // Roku OS 20 (a version we WANT to serve) and stay green on 14.0 (one we do not).
    // What the XML serves must be the module's own constant — that is the regression a
    // test can see. Whether the constant is still current is a release-time check against
    // Roku's release notes, not something a unit test can know.
    expect(info).toContain(`<software-version>${SOFTWARE_VERSION}</software-version>`);
    // A floor with a reason: 15 is the major this adapter's pairing was proven against,
    // and the value only ever moves forward. It catches a slip back to the 7.5.0 the
    // pre-0.5.0 adapter advertised, which modern remotes refuse to pair with.
    expect(Number(SOFTWARE_VERSION.split(".")[0])).toBeGreaterThanOrEqual(15);
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
  it("escapes the friendly name — a user's name must not break the description a remote parses", () => {
    expect(buildDescXml(device, "A & B <TV>", "player")).toContain("<friendlyName>A &amp; B &lt;TV&gt;</friendlyName>");
  });
  it("a TV root description uses the tv device type", () => {
    expect(buildDescXml(device, "Living Room", "tv")).toContain("urn:roku-com:device:tv:1-0");
  });
});

describe("buildAppsXml", () => {
  it("escapes a quote in an app id, which sits in an attribute", () => {
    expect(buildAppsXml([{ id: 'a"b', name: "X" }])).toContain('id="a&quot;b"');
  });
  it("renders configured apps and no dead 2015 services", () => {
    const apps = buildAppsXml(DEFAULT_APPS);
    expect(apps).toContain('<app id="12">Netflix</app>');
    expect(apps).not.toContain("Blockbuster");
  });
});
