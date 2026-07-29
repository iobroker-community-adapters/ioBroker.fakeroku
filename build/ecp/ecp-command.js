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
var ecp_command_exports = {};
__export(ecp_command_exports, {
  parseEcpCommand: () => parseEcpCommand
});
module.exports = __toCommonJS(ecp_command_exports);
var import_pure_helpers = require("../lib/pure-helpers");
function parseEcpCommand(method, url) {
  if (method !== "POST") {
    return null;
  }
  const [path, query] = url.split("?");
  const match = path.match(/^\/([^/]+)(?:\/(.+))?$/);
  if (!match) {
    return null;
  }
  const verb = match[1];
  const arg = match[2];
  switch (verb) {
    case "keypress":
    case "keydown":
    case "keyup":
      return arg ? { type: verb, key: (0, import_pure_helpers.normalizeKey)(arg) } : null;
    case "launch":
    case "install":
      return arg ? { type: verb, appId: arg } : null;
    case "input":
    case "search":
      return { type: verb, text: query != null ? query : "" };
    default:
      return null;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  parseEcpCommand
});
//# sourceMappingURL=ecp-command.js.map
