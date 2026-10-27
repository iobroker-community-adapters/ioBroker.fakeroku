"use strict";
// Loaded into the adapter process by test/inventory.js (FIXTURE_HOOKS). The emulator listens on port 1900 of every
// interface and answers each Roku search from its networks — on a developer's LAN a real controller (a Harmony hub, a
// phone) searches now and then, and the answer left the machine in the middle of the run. This hook plays a network
// with nobody else on it: a datagram whose sender is not this machine never reaches a socket of the adapter. The
// suites' own searches come from this machine and still arrive.
const dgram = require("node:dgram");
const os = require("node:os");

const LOOPBACK = /^(?:127\.|::1$|::ffff:127\.)/;
/**
 * @returns {Set<string>} every address of this machine, without an IPv6 zone
 */
const ownAddresses = () =>
  new Set(
    Object.values(os.networkInterfaces())
      .flat()
      .filter(Boolean)
      .map(a => a.address.split("%")[0]),
  );

const emit = dgram.Socket.prototype.emit;
dgram.Socket.prototype.emit = function (event, ...args) {
  if (event === "message") {
    const from = typeof args[1]?.address === "string" ? args[1].address.split("%")[0] : undefined;
    if (from !== undefined && !LOOPBACK.test(from) && !ownAddresses().has(from)) {
      return false;
    }
  }
  return emit.call(this, event, ...args);
};
