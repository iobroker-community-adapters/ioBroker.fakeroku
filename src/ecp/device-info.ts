import type { RokuAdvert } from "../discovery/ssdp-messages";
import type { DeviceType } from "./state-model";

/**
 * A fake but CURRENT Roku OS version, kept at the newest Roku OS major (checked 2026-09-24: Roku
 * OS 15 — 15.3 is the newest public release, 16.0 is a developer beta; support.roku.com release
 * notes). It makes the emulated device look like a device of today to anything that reads it.
 *
 * It is NOT a proven pairing lever. The thread this adapter once cited for it (Home Assistant
 * forum #501046) found its fix in answering /query/apps, and a Sofabaton pairs with
 * emulated_roku, which still reports 7.5.0. No controller is known to reject an old version.
 * The build number is cosmetic. (The official Roku app is a different case: it uses ECP-2 and
 * never reads device-info.)
 */
export const SOFTWARE_VERSION = "15.0.0";
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
    // Roku TVs announce themselves as a player too (a TCL or onn. Roku TV serves exactly this
    // URN); `...:tv:1-0` exists nowhere else, and Home Assistant's SSDP filter never matched it.
    deviceType: "urn:roku-com:device:player:1-0",
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

/** A minimal, current default app list served at /query/apps (no dead 2015 services). */
export const DEFAULT_APPS: AppEntry[] = [
  { id: "12", name: "Netflix" },
  { id: "837", name: "YouTube" },
  { id: "13", name: "Prime Video" },
  { id: "291097", name: "Disney Plus" },
];

/**
 * Escape XML text content and attribute values.
 *
 * @param s the raw text
 * @returns the escaped text
 */
function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
  <friendly-model-name>${p.modelName}</friendly-model-name>
  <default-device-name>${p.modelName} - ${device.uuid}</default-device-name>
  <user-device-name>${xmlEscape(friendlyName)}</user-device-name>
  <user-device-location></user-device-location>
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

/**
 * The service description the root description points at (`<SCPDURL>ecp_SCPD.xml</SCPDURL>`).
 *
 * ECP is a plain HTTP interface, not a SOAP service, so there is nothing to declare — but a
 * description that advertises a document and then answers 404 for it is a contradiction a
 * strict UPnP control point can trip over. This is the minimal valid SCPD: the mandatory
 * version block and two empty lists.
 *
 * @returns the SCPD XML
 */
export function buildScpdXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList/>
  <serviceStateTable/>
</scpd>`;
}

/**
 * The app on screen: always the Roku home screen, which is the answer a real Roku gives while no
 * app runs — an emulator never runs one.
 *
 * Not in Roku's current ECP table, but the controllers ask for it on every update: Home
 * Assistant's `rokuecp` fails the whole setup on a 404 here (`cannot_connect`), openHAB marks the
 * device offline. The answer has no app id, so neither goes on to ask for a TV channel.
 *
 * @returns the active-app XML
 */
export function buildActiveAppXml(): string {
  return `<active-app>\n  <app>Roku</app>\n</active-app>`;
}

/**
 * The media player state: nothing playing. openHAB asks for it after every active-app query that
 * carries no app id, and a 404 turns into an offline device there.
 *
 * @returns the media-player XML
 */
export function buildMediaPlayerXml(): string {
  return `<player error="false" state="close"/>`;
}

/**
 * The TV channel list of a Roku TV: empty — the emulator has no tuner. `rokuecp` asks for it on a
 * device that says `is-tv`, and takes an empty list as an empty list.
 *
 * @returns the tv-channels XML
 */
export function buildTvChannelsXml(): string {
  return `<tv-channels/>`;
}

/**
 * The icon of an app at /query/icon/<id>: a transparent 1×1 PNG. The emulator has no artwork,
 * but a 404 made Home Assistant's media browser show broken images and made node-roku-client's
 * `icon()` throw.
 */
export const APP_ICON_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
  "base64",
);
