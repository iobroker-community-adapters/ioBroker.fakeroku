import type { RokuAdvert } from "../discovery/ssdp-messages";

/**
 * A fake but CURRENT Roku OS version. This is the pairing lever: modern remotes
 * (Sofabaton X1, the Roku app) read /query/device-info and reject a too-old
 * version — emulated_roku hardcodes 7.5.0 / "Roku 4" (2016) and fails there, the
 * old fakeroku had no device-info at all. The exact "new enough" value is not
 * documented; verify against real hardware (a Sofabaton) and bump if needed.
 */
const SOFTWARE_VERSION = "14.1.4";
const SOFTWARE_BUILD = "4200";
const MODEL_NAME = "Roku Ultra";
const MODEL_NUMBER = "4800X";

/** One configured app entry for /query/apps. */
export interface AppEntry {
  /** Roku app id. */
  id: string;
  /** Display name. */
  name: string;
}

/** A minimal, current default app list (no dead 2015 services). Made configurable later. */
export const DEFAULT_APPS: AppEntry[] = [
  { id: "12", name: "Netflix" },
  { id: "837", name: "YouTube" },
  { id: "13", name: "Prime Video" },
  { id: "291097", name: "Disney Plus" },
];

/**
 * Escape XML text content.
 *
 * @param s the raw text
 * @returns the escaped text
 */
function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * UPnP root description served at `GET /` — the device "business card".
 *
 * @param device the emulated Roku
 * @param friendlyName the configured device name
 * @returns the UPnP root XML
 */
export function buildDescXml(device: RokuAdvert, friendlyName: string): string {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:roku-com:device:player:1-0</deviceType>
    <friendlyName>${xmlEscape(friendlyName)}</friendlyName>
    <manufacturer>Roku</manufacturer>
    <modelName>${MODEL_NAME}</modelName>
    <modelNumber>${MODEL_NUMBER}</modelNumber>
    <serialNumber>${device.uuid}</serialNumber>
    <UDN>uuid:roku:ecp:${device.uuid}</UDN>
    <serviceList>
      <service>
        <serviceType>urn:roku-com:service:ecp:1</serviceType>
        <serviceId>urn:roku-com:serviceId:ecp1-0</serviceId>
        <controlURL/>
        <eventSubURL/>
        <SCPDURL>ecp_SCPD.xml</SCPDURL>
      </service>
    </serviceList>
  </device>
</root>`;
}

/**
 * The `/query/device-info` payload — read by controllers at pairing time and
 * checked for a current version.
 *
 * @param device the emulated Roku
 * @param friendlyName the configured device name
 * @returns the device-info XML
 */
export function buildDeviceInfoXml(device: RokuAdvert, friendlyName: string): string {
  return `<device-info>
  <udn>${device.uuid}</udn>
  <serial-number>${device.uuid}</serial-number>
  <device-id>${device.uuid}</device-id>
  <vendor-name>Roku</vendor-name>
  <model-name>${MODEL_NAME}</model-name>
  <model-number>${MODEL_NUMBER}</model-number>
  <model-region>US</model-region>
  <friendly-device-name>${xmlEscape(friendlyName)}</friendly-device-name>
  <is-tv>false</is-tv>
  <is-stick>false</is-stick>
  <software-version>${SOFTWARE_VERSION}</software-version>
  <software-build>${SOFTWARE_BUILD}</software-build>
  <power-mode>PowerOn</power-mode>
  <supports-suspend>false</supports-suspend>
  <supports-find-remote>false</supports-find-remote>
  <developer-enabled>false</developer-enabled>
  <search-enabled>true</search-enabled>
  <voice-search-enabled>true</voice-search-enabled>
  <notifications-enabled>true</notifications-enabled>
  <headphones-connected>false</headphones-connected>
</device-info>`;
}

/**
 * The `/query/apps` list.
 *
 * @param apps the configured apps
 * @returns the apps XML
 */
export function buildAppsXml(apps: AppEntry[]): string {
  const entries = apps.map(a => `  <app id="${xmlEscape(a.id)}">${xmlEscape(a.name)}</app>`).join("\n");
  return `<apps>\n${entries}\n</apps>`;
}
