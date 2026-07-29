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
  STANDARD_KEYS: () => STANDARD_KEYS,
  commandToStateWrite: () => commandToStateWrite
});
module.exports = __toCommonJS(state_model_exports);
const STANDARD_KEYS = [
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
  "InputAV1",
  "FindRemote"
];
const STANDARD_KEY_SET = new Set(STANDARD_KEYS);
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
    command: describeCommand(cmd),
    commandType: cmd.type,
    pulseKey: null,
    holdKey: null
  };
  if (cmd.key && STANDARD_KEY_SET.has(cmd.key)) {
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
  STANDARD_KEYS,
  commandToStateWrite
});
//# sourceMappingURL=state-model.js.map
