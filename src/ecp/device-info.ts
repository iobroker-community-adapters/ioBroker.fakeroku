import type { RokuAdvert } from "../discovery/ssdp-messages";
import type { DeviceType } from "./state-model";

/**
 * A fake but CURRENT Roku OS version. This is the pairing lever: modern remotes
 * (Sofabaton X1, the Roku app) read /query/device-info and reject a too-old
 * version — emulated_roku hardcodes 7.5.0 / "Roku 4" (2016) and fails there, the
 * old fakeroku had no device-info at all. The exact "new enough" value is not
 * documented; verify against real hardware (a Sofabaton) and bump if needed.
 */
const SOFTWARE_VERSION = "14.1.4";
const SOFTWARE_BUILD = "4200";

/** Per-device-type identity + capability flags advertised in device-info. */
interface DeviceProfile {
  modelName: string;
  modelNumber: string;
  deviceType: string;
  isTv: boolean;
  supportsTvPowerControl: boolean;
  supportsAudioVolumeControl: boolean;
}

/**
 * The two emulated device profiles. A player is a streaming box (no volume/power/
 * channel/input keys); a TV additionally controls volume, power, channel and input,
 * which is exactly what the extra ECP keys and the capability flags reflect.
 */
const PROFILES: Record<DeviceType, DeviceProfile> = {
  player: {
    modelName: "Roku Ultra",
    modelNumber: "4800X",
    deviceType: "urn:roku-com:device:player:1-0",
    isTv: false,
    supportsTvPowerControl: false,
    supportsAudioVolumeControl: false,
  },
  tv: {
    modelName: "Roku TV",
    modelNumber: "C4A4X",
    deviceType: "urn:roku-com:device:tv:1-0",
    isTv: true,
    supportsTvPowerControl: true,
    supportsAudioVolumeControl: true,
  },
};

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
 * @param type the emulated device type (player / tv)
 * @returns the UPnP root XML
 */
export function buildDescXml(device: RokuAdvert, friendlyName: string, type: DeviceType): string {
  const p = PROFILES[type];
  return `<?xml version="1.0" encoding="UTF-8" ?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>${p.deviceType}</deviceType>
    <friendlyName>${xmlEscape(friendlyName)}</friendlyName>
    <manufacturer>Roku</manufacturer>
    <modelName>${p.modelName}</modelName>
    <modelNumber>${p.modelNumber}</modelNumber>
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
 * checked for a current version. The `is-tv` / `supports-*` flags follow the
 * device type so a controller (e.g. Harmony) offers the matching key set.
 *
 * @param device the emulated Roku
 * @param friendlyName the configured device name
 * @param type the emulated device type (player / tv)
 * @returns the device-info XML
 */
export function buildDeviceInfoXml(device: RokuAdvert, friendlyName: string, type: DeviceType): string {
  const p = PROFILES[type];
  return `<device-info>
  <udn>${device.uuid}</udn>
  <serial-number>${device.uuid}</serial-number>
  <device-id>${device.uuid}</device-id>
  <vendor-name>Roku</vendor-name>
  <model-name>${p.modelName}</model-name>
  <model-number>${p.modelNumber}</model-number>
  <model-region>US</model-region>
  <friendly-device-name>${xmlEscape(friendlyName)}</friendly-device-name>
  <is-tv>${p.isTv}</is-tv>
  <is-stick>false</is-stick>
  <software-version>${SOFTWARE_VERSION}</software-version>
  <software-build>${SOFTWARE_BUILD}</software-build>
  <power-mode>PowerOn</power-mode>
  <supports-suspend>false</supports-suspend>
  <supports-find-remote>true</supports-find-remote>
  <supports-tv-power-control>${p.supportsTvPowerControl}</supports-tv-power-control>
  <supports-audio-volume-control>${p.supportsAudioVolumeControl}</supports-audio-volume-control>
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
