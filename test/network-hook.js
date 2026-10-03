"use strict";
// Loaded into the adapter process by test/inventory.js as the LAST hook of `adapterEnv()` — in the suites "counterpart
// gone and back", "chosen network address" and "missing network address" — so its patches sit outside every fixture hook.
// 1. It records where the process listens, binds, joins multicast groups, sends and connects: one JSON line per call in
//    RESOURCE_PROBE_DIR/<pid>.net (krobi 2026-10-03 00:27: the chosen address is the only one the adapter uses).
// 2. It plays a power cut of every counterpart: while the file `outage` exists in RESOURCE_PROBE_DIR, every network path
//    of the process fails like an unplugged device — new TCP/TLS connections and `fetch` are refused, open connections
//    drop, incoming connections are dropped, UDP datagrams neither leave nor arrive. Removing the file brings everything
//    back. Each time it goes on it writes `<pid>.outage`, naming any of its patches a later hook replaced.
// The ioBroker databases (ports from the controller's own iobroker.json) are never cut nor recorded: they are the
// platform, not the counterpart.
// Fleet master (.consistency-master/test/network-hook.js) — never edit the copy in an adapter.
const fs = require("node:fs");
const net = require("node:net");
const dgram = require("node:dgram");
const path = require("node:path");

const dir = process.env.RESOURCE_PROBE_DIR;
if (!dir) {
  throw new Error("network hook: RESOURCE_PROBE_DIR is not set — load it through adapterEnv()");
}
const flag = path.join(dir, "outage");
// js-controller reads <root>/iobroker-data/iobroker.json; the harness starts the adapter in <root>/node_modules/<adapter>.
const config = process.env.IOBROKER_DATA_DIR
  ? path.join(process.env.IOBROKER_DATA_DIR, "iobroker.json")
  : path.join(process.cwd(), "..", "..", "iobroker-data", "iobroker.json");
let keep;
try {
  const { objects, states } = JSON.parse(fs.readFileSync(config, "utf8"));
  keep = new Set([Number(objects.port), Number(states.port)]);
} catch (err) {
  throw new Error(`network hook: cannot read the database ports from ${config} (${err.message})`);
}
if (![...keep].every(p => Number.isInteger(p) && p > 0)) {
  throw new Error(`network hook: ${config} names no database ports`);
}

const log = path.join(dir, `${process.pid}.net`);
// A test hook's own server or socket (a fixture served inside the adapter process) is not the adapter's: it is marked
// `hook` when a frame of a test folder is on the stack and no frame of the adapter's own code is — the adapter runs from
// the test installation below the working directory. A request a hook only reroutes keeps the adapter's frame.
const root = process.cwd();
const byHook = () => {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 80;
  const stack = new Error().stack || "";
  Error.stackTraceLimit = limit;
  let hook = false;
  for (const line of stack.split("\n").slice(2)) {
    const m = line.match(/\(?((?:file:\/\/)?\/[^():]+):\d+/);
    if (!m || line.includes("node:") || line.includes(__filename)) {
      continue;
    }
    const file = m[1].replace("file://", "");
    const rel = path.relative(root, file);
    if (!rel.startsWith("..") && !rel.startsWith("node_modules") && !/(^|\/)test\//.test(rel)) {
      return false;
    }
    if (/\/test\//.test(file) && !file.includes("/node_modules/")) {
      hook = true;
    }
  }
  return hook;
};
const record = (entry, hook = byHook()) =>
  fs.appendFileSync(log, `${JSON.stringify(hook ? { ...entry, hook } : entry)}\n`);
const ids = new WeakMap();
let nextId = 0;
const idOf = socket => {
  if (!ids.has(socket)) {
    ids.set(socket, ++nextId);
  }
  return ids.get(socket);
};
const down = () => fs.existsSync(flag);
const refused = () => Object.assign(new Error("connect ECONNREFUSED (outage switch)"), { code: "ECONNREFUSED" });
const reset = () => Object.assign(new Error("read ECONNRESET (outage switch)"), { code: "ECONNRESET" });
const optionsOf = args => {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  return first && typeof first === "object"
    ? first
    : { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
};

// Outgoing TCP and TLS (TLS opens its socket through net): http, MQTT clients, and undici behind fetch.
const open = new Set();
const track = socket => {
  open.add(socket);
  socket.once("close", () => open.delete(socket));
};
const connect = net.Socket.prototype.connect;
function cutConnect(...args) {
  const opts = optionsOf(args);
  const result = connect.apply(this, args);
  if (keep.has(Number(opts.port))) {
    return result;
  }
  if (opts.path === undefined) {
    record({
      kind: "connect",
      host: opts.host ?? "localhost",
      port: Number(opts.port),
      localAddress: opts.localAddress,
    });
  }
  track(this);
  if (down()) {
    process.nextTick(() => this.destroy(refused()));
  }
  return result;
}
net.Socket.prototype.connect = cutConnect;

// Listening TCP servers (http, fastify): the address the server really holds, once it listens.
const listen = net.Server.prototype.listen;
function recordListen(...args) {
  const hook = byHook();
  this.once("listening", () => {
    const at = this.address();
    if (at && typeof at === "object") {
      record({ kind: "listen", host: at.address, port: at.port }, hook);
    }
  });
  return listen.apply(this, args);
}
net.Server.prototype.listen = recordListen;

// Incoming TCP: a counterpart that connects to a server of the adapter.
const serverEmit = net.Server.prototype.emit;
function cutServerEmit(event, ...args) {
  if (event === "connection" && args[0] instanceof net.Socket) {
    if (down()) {
      args[0].destroy();
      return false;
    }
    track(args[0]);
  }
  return serverEmit.call(this, event, ...args);
}
net.Server.prototype.emit = cutServerEmit;

// fetch: wrapped at the call, so a fixture hook that assigns globalThis.fetch is cut as well.
let current = globalThis.fetch;
const cutFetch = (...args) =>
  down() ? Promise.reject(new TypeError("fetch failed", { cause: refused() })) : current(...args);
function getFetch() {
  return current && cutFetch;
}
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  enumerable: true,
  get: getFetch,
  set(fn) {
    current = fn;
  },
});

// UDP: where each socket binds, which groups it joins on which interface, where its multicast leaves, where it sends.
const bind = dgram.Socket.prototype.bind;
function recordBind(...args) {
  const hook = byHook();
  this.once("listening", () => {
    const at = this.address();
    record({ kind: "bind", id: idOf(this), address: at.address, port: at.port }, hook);
  });
  return bind.apply(this, args);
}
dgram.Socket.prototype.bind = recordBind;
const addMembership = dgram.Socket.prototype.addMembership;
function recordJoin(group, iface) {
  record({ kind: "join", id: idOf(this), group, iface });
  return addMembership.call(this, group, iface);
}
dgram.Socket.prototype.addMembership = recordJoin;
const setMulticastInterface = dgram.Socket.prototype.setMulticastInterface;
function recordEgress(iface) {
  record({ kind: "egress", id: idOf(this), iface });
  return setMulticastInterface.call(this, iface);
}
dgram.Socket.prototype.setMulticastInterface = recordEgress;
const sentTo = new Set();
const send = dgram.Socket.prototype.send;
function cutSend(...args) {
  const at = args.findIndex(a => typeof a === "number");
  const target = { port: args[at], host: typeof args[at + 1] === "string" ? args[at + 1] : "localhost" };
  const key = `${idOf(this)} ${target.host}:${target.port}`;
  if (at !== -1 && !sentTo.has(key)) {
    sentTo.add(key);
    record({ kind: "send", id: idOf(this), host: target.host, port: target.port });
  }
  if (!down()) {
    return send.apply(this, args);
  }
  const cb = args.find(a => typeof a === "function");
  if (cb) {
    process.nextTick(cb, null, 0);
  }
}
dgram.Socket.prototype.send = cutSend;
const emit = dgram.Socket.prototype.emit;
function cutEmit(event, ...args) {
  if (event === "message" && down()) {
    return false;
  }
  return emit.call(this, event, ...args);
}
dgram.Socket.prototype.emit = cutEmit;

/** The patches a later hook replaced — each would let a path past the cut or the record. */
function replaced() {
  const out = [];
  if (net.Socket.prototype.connect !== cutConnect) out.push("net.Socket.prototype.connect");
  if (net.Server.prototype.listen !== recordListen) out.push("net.Server.prototype.listen");
  if (net.Server.prototype.emit !== cutServerEmit) out.push("net.Server.prototype.emit");
  if (Object.getOwnPropertyDescriptor(globalThis, "fetch")?.get !== getFetch) out.push("globalThis.fetch");
  if (dgram.Socket.prototype.bind !== recordBind) out.push("dgram.Socket.prototype.bind");
  if (dgram.Socket.prototype.addMembership !== recordJoin) out.push("dgram.Socket.prototype.addMembership");
  if (dgram.Socket.prototype.setMulticastInterface !== recordEgress)
    out.push("dgram.Socket.prototype.setMulticastInterface");
  if (dgram.Socket.prototype.send !== cutSend) out.push("dgram.Socket.prototype.send");
  if (dgram.Socket.prototype.emit !== cutEmit) out.push("dgram.Socket.prototype.emit");
  return out;
}

// The moment the switch goes on, open connections drop and the marker is written.
let was = down();
setInterval(() => {
  const now = down();
  if (now && !was) {
    for (const socket of open) {
      socket.destroy(reset());
    }
    fs.writeFileSync(path.join(dir, `${process.pid}.outage`), JSON.stringify({ replaced: replaced() }));
  }
  was = now;
}, 100).unref();
