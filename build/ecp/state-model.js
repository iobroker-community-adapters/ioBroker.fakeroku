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
var state_model_exports = {};
__export(state_model_exports, {
  BASE_KEYS: () => BASE_KEYS,
  MAX_COMMAND_LENGTH: () => MAX_COMMAND_LENGTH,
  TV_KEYS: () => TV_KEYS,
  commandToStateWrite: () => commandToStateWrite,
  keysForType: () => keysForType
});
module.exports = __toCommonJS(state_model_exports);
const MAX_COMMAND_LENGTH = 500;
const BASE_KEYS = [
  "Home",
  "Rev",
  "Fwd",
  "Play",
  "Select",
  "Left",
  "Right",
  "Up",
  "Down",
  "Back",
  "InstantReplay",
  "Info",
  "Backspace",
  "Enter",
  "Search",
  "FindRemote"
];
const TV_KEYS = [
  "VolumeUp",
  "VolumeDown",
  "VolumeMute",
  "PowerOff",
  "ChannelUp",
  "ChannelDown",
  "InputHDMI1",
  "InputHDMI2",
  "InputHDMI3",
  "InputHDMI4",
  "InputAV1"
];
const ALL_KEYS = /* @__PURE__ */ new Set([...BASE_KEYS, ...TV_KEYS]);
function keysForType(type) {
  return type === "tv" ? [...BASE_KEYS, ...TV_KEYS] : BASE_KEYS;
}
function describeCommand(cmd) {
  var _a, _b, _c;
  switch (cmd.type) {
    case "keypress":
    case "keydown":
    case "keyup":
      return (_a = cmd.key) != null ? _a : "";
    case "launch":
    case "install":
      return `${cmd.type}:${(_b = cmd.appId) != null ? _b : ""}`;
    case "input":
    case "search":
      return `${cmd.type}:${(_c = cmd.text) != null ? _c : ""}`;
  }
}
function commandToStateWrite(cmd) {
  const write = {
    command: describeCommand(cmd).slice(0, MAX_COMMAND_LENGTH),
    commandType: cmd.type,
    pulseKey: null,
    holdKey: null
  };
  if (cmd.key && ALL_KEYS.has(cmd.key)) {
    if (cmd.type === "keypress") {
      write.pulseKey = cmd.key;
    } else if (cmd.type === "keydown") {
      write.holdKey = { key: cmd.key, value: true };
    } else if (cmd.type === "keyup") {
      write.holdKey = { key: cmd.key, value: false };
    }
  }
  return write;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BASE_KEYS,
  MAX_COMMAND_LENGTH,
  TV_KEYS,
  commandToStateWrite,
  keysForType
});
//# sourceMappingURL=state-model.js.map
