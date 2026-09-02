import type { Mock } from "vitest";
import { RokuSsdpResponder } from "./ssdp-responder";

// dgram is mocked so the interface handling in start() (per-interface addMembership +
// setMulticastInterface) and the runtime socket-death path are unit-testable without a
// real socket. Follows the govee-lan-client mock shape.
const dgramMock = vi.hoisted(() => {
  interface FakeSocket {
    membership: Array<string | undefined>;
    mcastIf: string[];
    closed: boolean;
    options: unknown;
    handlers: Record<string, Array<(...a: unknown[]) => void>>;
    once: (ev: string, cb: (...a: unknown[]) => void) => FakeSocket;
    on: (ev: string, cb: (...a: unknown[]) => void) => FakeSocket;
    removeListener: (ev: string, cb: (...a: unknown[]) => void) => FakeSocket;
    bind: (port: unknown, cb?: () => void) => FakeSocket;
    addMembership: (addr: string, iface?: string) => void;
    setMulticastInterface: (iface: string) => void;
    sent: Array<{ text: string; port: number; address: string }>;
    send: (...args: unknown[]) => void;
    close: () => void;
    emit: (ev: string, ...args: unknown[]) => void;
  }
  const sockets: FakeSocket[] = [];
  // Injectable failures — each is the real OS error the production code guards.
  const fail = { bind: false, join: false, mcastIf: false, send: false, close: false, throwString: false };
  const make = (options?: unknown): FakeSocket => {
    const s: FakeSocket = {
      options,
      membership: [],
      mcastIf: [],
      sent: [],
      closed: false,
      handlers: {},
      once: (ev, cb) => s.on(ev, cb),
      on: (ev, cb) => {
        (s.handlers[ev] ??= []).push(cb);
        return s;
      },
      removeListener: (ev, cb) => {
        s.handlers[ev] = (s.handlers[ev] ?? []).filter(h => h !== cb);
        return s;
      },
      bind: (_port, cb) => {
        if (fail.bind) {
          s.emit("error", new Error("EADDRINUSE"));
        } else if (typeof cb === "function") {
          cb();
        }
        return s;
      },
      addMembership: (_addr, iface) => {
        if (fail.throwString) {
          // Deliberately not an Error: the responder must cope with a string throw.
          throw "EPERM-ish string" as unknown;
        }
        if (fail.join) {
          throw new Error("ENODEV");
        }
        s.membership.push(iface);
      },
      setMulticastInterface: iface => {
        if (fail.mcastIf) {
          throw new Error("EINVAL");
        }
        s.mcastIf.push(iface);
      },
      send: (...args) => {
        const cb = args[args.length - 1];
        if (!fail.send) {
          s.sent.push({
            text: String(args[0]),
            port: args[1] as number,
            address: args[2] as string,
          });
        }
        if (typeof cb === "function") {
          (cb as (e?: Error) => void)(fail.send ? new Error("ENETUNREACH") : undefined);
        }
      },
      close: () => {
        if (fail.close) {
          throw new Error("ERR_SOCKET_DGRAM_NOT_RUNNING");
        }
        s.closed = true;
      },
      emit: (ev, ...args) => {
        (s.handlers[ev] ?? []).forEach(h => h(...args));
      },
    };
    sockets.push(s);
    return s;
  };
  return { sockets, make, fail };
});
vi.mock("node:dgram", () => ({ createSocket: (options: unknown) => dgramMock.make(options) }));

/** A logger that records what the responder said, so warn-vs-silence is assertable. */
function recordingLog(): { debug: Mock; warn: Mock; error: Mock } {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}
const noopLog = recordingLog();
const baseCfg = { devices: [{ uuid: "abc123", port: 8060 }], advertiseIp: "10.0.0.9", logger: noopLog };

/** A minimal well-formed M-SEARCH a Roku must answer. */
const MSEARCH = ["M-SEARCH * HTTP/1.1", "HOST: 239.255.255.250:1900", 'MAN: "ssdp:discover"', "ST: roku:ecp", ""].join(
  "\r\n",
);

describe("RokuSsdpResponder", () => {
  beforeEach(() => {
    dgramMock.sockets.length = 0;
    Object.keys(dgramMock.fail).forEach(k => ((dgramMock.fail as Record<string, boolean>)[k] = false));
    vi.clearAllMocks();
  });

  it("auto mode joins the group on every provided interface and does not pin egress", async () => {
    const r = new RokuSsdpResponder({
      ...baseCfg,
      bindIp: undefined,
      membershipInterfaces: ["10.0.0.9", "192.168.1.5"],
    });
    await r.start();
    const s = dgramMock.sockets[0];
    expect(s.membership).toEqual(["10.0.0.9", "192.168.1.5"]);
    expect(s.mcastIf).toEqual([]);
  });

  it("a chosen interface joins on that one and pins the multicast egress to it", async () => {
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: "10.0.0.9", membershipInterfaces: ["10.0.0.9"] });
    await r.start();
    const s = dgramMock.sockets[0];
    expect(s.membership).toEqual(["10.0.0.9"]);
    expect(s.mcastIf).toEqual(["10.0.0.9"]);
  });

  it("binds port 1900 shareable, so another SSDP service on the host can coexist", async () => {
    // hueemu (and any UPnP stack) sits on the same port; without reuseAddr the second
    // one to start fails its bind and one of the two emulators is undiscoverable.
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [] });
    await r.start();
    expect(dgramMock.sockets[0].options).toEqual({ type: "udp4", reuseAddr: true });
  });

  it("with no interface known joins on the OS default", async () => {
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [] });
    await r.start();
    expect(dgramMock.sockets[0].membership).toEqual([undefined]);
  });

  it("reports a runtime socket death exactly once and closes the socket", async () => {
    const fatal = vi.fn();
    const r = new RokuSsdpResponder({
      ...baseCfg,
      bindIp: undefined,
      membershipInterfaces: ["10.0.0.9"],
      onFatalError: fatal,
    });
    await r.start();
    const s = dgramMock.sockets[0];
    s.emit("error", new Error("EADDRNOTAVAIL"));
    s.emit("error", new Error("second"));
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(s.closed).toBe(true);
  });

  it("rejects when port 1900 is already taken", async () => {
    // main.ts turns this rejection into "discovery off, ECP still up". If start()
    // resolved instead, the adapter would announce into a dead socket and report
    // working discovery that never answers an M-SEARCH.
    dgramMock.fail.bind = true;
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [] });
    await expect(r.start()).rejects.toThrow("EADDRINUSE");
  });

  it("a failed group join warns but still starts", async () => {
    dgramMock.fail.join = true;
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: ["10.0.0.9"] });
    // One interface out of the multicast routing table must not kill discovery on
    // the others — and a silent failure would leave "no device found" unexplainable.
    await expect(r.start()).resolves.toBeUndefined();
    expect(noopLog.warn).toHaveBeenCalledWith(expect.stringContaining("multicast join failed on 10.0.0.9"));
  });

  it("names the default interface when the OS-default join fails", async () => {
    dgramMock.fail.join = true;
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [] });
    await r.start();
    // "join failed on undefined" tells the user nothing about which interface.
    expect(noopLog.warn).toHaveBeenCalledWith(expect.stringContaining("join failed on default interface"));
  });

  it("reports a non-Error thrown by the OS binding", async () => {
    dgramMock.fail.throwString = true;
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: ["10.0.0.9"] });
    await r.start();
    // node-gyp bindings can reject with a bare string; `e.message` would be
    // undefined and the warning would name no cause at all.
    expect(noopLog.warn).toHaveBeenCalledWith(expect.stringContaining("EPERM-ish string"));
  });

  it("a failed egress pin warns but still starts", async () => {
    dgramMock.fail.mcastIf = true;
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: "10.0.0.9", membershipInterfaces: ["10.0.0.9"] });
    await expect(r.start()).resolves.toBeUndefined();
    expect(noopLog.warn).toHaveBeenCalledWith(expect.stringContaining("could not pin multicast egress"));
  });

  it("answers an M-SEARCH once per device, unicast back to the asking controller", async () => {
    const r = new RokuSsdpResponder({
      ...baseCfg,
      devices: [
        { uuid: "aaa", port: 8060 },
        { uuid: "bbb", port: 8061 },
      ],
      bindIp: undefined,
      membershipInterfaces: [],
    });
    await r.start();
    const s = dgramMock.sockets[0];
    s.emit("message", Buffer.from(MSEARCH), { address: "10.0.0.50", port: 41234 });
    expect(s.sent).toHaveLength(2);
    // The reply goes to the controller's source address/port, not to the multicast
    // group — a broadcast answer is ignored by the asking socket.
    expect(s.sent.map(x => `${x.address}:${x.port}`)).toEqual(["10.0.0.50:41234", "10.0.0.50:41234"]);
    expect(s.sent[0].text).toContain("uuid:roku:ecp:aaa");
    expect(s.sent[1].text).toContain("uuid:roku:ecp:bbb");
    expect(s.sent[0].text).toContain("http://10.0.0.9:8060/");
  });

  it("ignores a Roku search from outside the LAN — no reflection towards a spoofed source", async () => {
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [] });
    await r.start();
    const s = dgramMock.sockets[0];
    s.emit("message", Buffer.from(MSEARCH), { address: "8.8.8.8", port: 1900 });
    // The socket listens on every interface; on a host with a public one an answer
    // would go to whatever address the datagram claims to come from.
    expect(s.sent).toEqual([]);
    expect(noopLog.debug).toHaveBeenCalledWith(expect.stringContaining("non-LAN 8.8.8.8"));
  });

  it("stays silent on traffic that is not a Roku search", async () => {
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [] });
    await r.start();
    const s = dgramMock.sockets[0];
    // Port 1900 carries every other device's SSDP chatter. Answering all of it
    // would flood the LAN and confuse controllers looking for something else.
    s.emit("message", Buffer.from(MSEARCH.replace("roku:ecp", "urn:dial-multiscreen-org:service:dial:1")), {
      address: "10.0.0.50",
      port: 41234,
    });
    s.emit("message", Buffer.from("NOTIFY * HTTP/1.1\r\nNTS: ssdp:alive\r\n\r\n"), {
      address: "10.0.0.51",
      port: 1900,
    });
    expect(s.sent).toEqual([]);
  });

  it("warns when a search answer cannot be sent", async () => {
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [] });
    await r.start();
    dgramMock.fail.send = true;
    dgramMock.sockets[0].emit("message", Buffer.from(MSEARCH), { address: "10.0.0.50", port: 41234 });
    // Warn, not throw: the send callback runs outside any try/catch, so an
    // unhandled throw here would take the adapter process down.
    expect(noopLog.warn).toHaveBeenCalledWith(expect.stringContaining("response send failed"));
  });

  it("announces every device to the multicast group", async () => {
    const r = new RokuSsdpResponder({
      ...baseCfg,
      devices: [
        { uuid: "aaa", port: 8060 },
        { uuid: "bbb", port: 8061 },
      ],
      bindIp: undefined,
      membershipInterfaces: [],
    });
    await r.start();
    const s = dgramMock.sockets[0];
    r.announce();
    expect(s.sent.map(x => `${x.address}:${x.port}`)).toEqual(["239.255.255.250:1900", "239.255.255.250:1900"]);
    expect(s.sent[0].text).toContain("NOTIFY * HTTP/1.1");
    expect(s.sent[0].text).toContain("ssdp:alive");
  });

  it("logs a failed announce at debug, not warn", async () => {
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [] });
    await r.start();
    dgramMock.fail.send = true;
    r.announce();
    // The announce runs on a timer: a warn per tick would fill the log on a host
    // that briefly loses its route. The M-SEARCH answer above IS a warn — that one
    // is a controller actively waiting for a reply.
    expect(noopLog.debug).toHaveBeenCalledWith(expect.stringContaining("NOTIFY send failed"));
    expect(noopLog.warn).not.toHaveBeenCalled();
  });

  it("announcing before start or after stop does nothing", async () => {
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [] });
    expect(() => r.announce()).not.toThrow();
    await r.start();
    const s = dgramMock.sockets[0];
    r.stop();
    r.announce();
    // After a fatal socket death the adapter's announce interval can still fire
    // once. Sending on a closed socket throws inside dgram — the guard is what
    // keeps that out of the timer callback.
    expect(s.sent).toEqual([]);
  });

  it("stop is idempotent and survives an already-dead socket", async () => {
    dgramMock.fail.close = true;
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [] });
    await r.start();
    // onUnload calls stop() synchronously; a throw there means the callback never
    // runs and js-controller SIGKILLs the adapter.
    expect(() => r.stop()).not.toThrow();
    expect(() => r.stop()).not.toThrow();
  });
});
