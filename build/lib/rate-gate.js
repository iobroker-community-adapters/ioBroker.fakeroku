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
var rate_gate_exports = {};
__export(rate_gate_exports, {
  RateGate: () => RateGate
});
module.exports = __toCommonJS(rate_gate_exports);
class RateGate {
  /**
   * @param perSecond how many commands may pass per second (also the burst size)
   * @param now the current time in milliseconds
   */
  constructor(perSecond, now) {
    this.perSecond = perSecond;
    this.tokens = perSecond;
    this.last = now;
  }
  perSecond;
  tokens;
  last;
  /**
   * Take one token if there is one.
   *
   * @param now the current time in milliseconds
   * @returns true if the command may pass, false if it exceeds the rate
   */
  allow(now) {
    const elapsedSeconds = Math.max(0, now - this.last) / 1e3;
    this.tokens = Math.min(this.perSecond, this.tokens + elapsedSeconds * this.perSecond);
    this.last = now;
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  RateGate
});
//# sourceMappingURL=rate-gate.js.map
