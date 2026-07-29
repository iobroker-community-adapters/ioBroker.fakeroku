"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var device_info_exports = {};
__export(device_info_exports, {
  DEFAULT_APPS: () => DEFAULT_APPS,
  buildAppsXml: () => buildAppsXml,
  buildDescXml: () => buildDescXml,
  buildDeviceInfoXml: () => buildDeviceInfoXml
});
module.exports = __toCommonJS(device_info_exports);
const SOFTWARE_VERSION = "14.1.4";
const SOFTWARE_BUILD = "4200";
const MODEL_NAME = "Roku Ultra";
const MODEL_NUMBER = "4800X";
const DEFAULT_APPS = [
  { id: "12", name: "Netflix" },
  { id: "837", name: "YouTube" },
  { id: "13", name: "Prime Video" },
  { id: "291097", name: "Disney Plus" }
];
function xmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function buildDescXml(device, friendlyName) {
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
function buildDeviceInfoXml(device, friendlyName) {
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
function buildAppsXml(apps) {
  const entries = apps.map((a) => `  <app id="${xmlEscape(a.id)}">${xmlEscape(a.name)}</app>`).join("\n");
  return `<apps>
${entries}
</apps>`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_APPS,
  buildAppsXml,
  buildDescXml,
  buildDeviceInfoXml
});
//# sourceMappingURL=device-info.js.map
