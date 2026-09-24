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
    /** What bind() was actually asked for — a wrong port or a bound address is invisible otherwise. */
    boundTo: Array<{ port: unknown; address: unknown }>;
    /** The multicast GROUP each join used, next to the interface it used. */
    joinedGroups: unknown[];
    send: (...args: unknown[]) => void;
    close: () => void;
    emit: (ev: string, ...args: unknown[]) => void;
  }
  const sockets: FakeSocket[] = [];
  // Injectable failures — each is the real OS error the production code guards.
  const fail = {
    bind: false,
    join: false,
    mcastIf: false,
    send: false,
    sendThrows: false,
    close: false,
    create: false,
    throwString: false,
  };
  const make = (options?: unknown): FakeSocket => {
    if (fail.create) {
      throw new Error("EMFILE");
    }
    const s: FakeSocket = {
      options,
      membership: [],
      joinedGroups: [],
      boundTo: [],
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
      bind: (port, cb) => {
        s.boundTo.push({ port, address: typeof cb === "function" ? undefined : cb });
        if (fail.bind) {
          s.emit("error", new Error("EADDRINUSE"));
        } else if (typeof cb === "function") {
          cb();
        }
        return s;
      },
      addMembership: (addr, iface) => {
        s.joinedGroups.push(addr);
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
        if (fail.sendThrows) {
          throw new Error("ERR_SOCKET_DGRAM_NOT_RUNNING");
        }
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
// Every client counts as local unless a test says otherwise — which clients are local is
// lan-guard's question (lan-guard.test.ts), not this file's.
const baseCfg = {
  devices: [{ uuid: "abc123", port: 8060 }],
  advertiseIp: "10.0.0.9",
  logger: noopLog,
  isClientAllowed: (): boolean => true,
};

/**
 * One interface to join on, named after its address so a test can tell them apart.
 *
 * @param address the interface address
 * @returns the membership
 */
function m(address: string): { iface: string; address: string } {
  return { iface: `if-${address}`, address };
}

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
      membershipInterfaces: [m("10.0.0.9"), m("192.168.1.5")],
    });
    await r.start();
    const s = dgramMock.sockets[0];
    expect(s.membership).toEqual(["10.0.0.9", "192.168.1.5"]);
    // The GROUP, not only the interface: joining the wrong address would leave the socket
    // bound and silent, and every assertion about the interface list would still hold.
    expect(s.joinedGroups).toEqual(["239.255.255.250", "239.255.255.250"]);
    // The receiving socket is not pinned — the NOTIFY senders are, one per interface.
    expect(s.mcastIf).toEqual([]);
    expect(dgramMock.sockets.slice(1).map(x => x.mcastIf)).toEqual([["10.0.0.9"], ["192.168.1.5"]]);
  });

  it("a chosen interface joins on that one and pins the multicast egress to it", async () => {
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: "10.0.0.9", membershipInterfaces: [m("10.0.0.9")] });
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
    // And it binds the standard port on ALL interfaces. Binding a concrete address here
    // would silently drop multicast from every other interface of a multi-homed host;
    // the egress pinning is setMulticastInterface's job, not the bind's.
    expect(dgramMock.sockets[0].boundTo).toEqual([{ port: 1900, address: undefined }]);
  });

  it("with no interface known joins on the OS default", async () => {
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [] });
    await r.start();
    expect(dgramMock.sockets[0].membership).toEqual([undefined]);
  });

  it("refreshAdvertise moves the announced address and joins only the NEW interface", async () => {
    // A membership was taken on the OLD interface address — the socket stops hearing
    // M-SEARCH on the new one until it joins again. Re-joining one it already has throws
    // EADDRINUSE, which tryJoin turns into a warning, so only genuinely new ones are joined.
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [m("10.0.0.9")] });
    await r.start();
    const s = dgramMock.sockets[0];
    expect(s.membership).toEqual(["10.0.0.9"]);

    // A multi-homed host that GAINED an address: one interface is already joined, one is
    // new. Joining the list blindly would take 10.0.0.9 a second time — EADDRINUSE, which
    // tryJoin turns into a warning on every pass.
    expect(r.refreshAdvertise("10.0.0.77", [m("10.0.0.9"), m("10.0.0.77")])).toBe(true);

    expect(s.membership).toEqual(["10.0.0.9", "10.0.0.77"]);
    expect(s.joinedGroups).toEqual(["239.255.255.250", "239.255.255.250"]);
    // The new address is in the next answer, not only in the next NOTIFY.
    s.emit("message", Buffer.from(MSEARCH), { address: "192.168.1.30", port: 1234 });
    await vi.waitFor(() => expect(s.sent.length).toBeGreaterThan(0));
    expect(s.sent.at(-1)!.text).toContain("10.0.0.77");
  });

  it("refreshAdvertise with the same address and interfaces changes nothing and joins nothing", async () => {
    // It runs every five minutes for the lifetime of the instance: a re-join per pass
    // would put an EADDRINUSE warning in the log forever.
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [m("10.0.0.9")] });
    await r.start();
    const s = dgramMock.sockets[0];

    expect(r.refreshAdvertise(baseCfg.advertiseIp, [m("10.0.0.9")])).toBe(false);

    expect(s.membership).toEqual(["10.0.0.9"]);
  });

  it("refreshAdvertise joins an interface that came up later, even when the address stays", async () => {
    // A second card or a VLAN that appears after the start: the primary address does not move,
    // and it used to stay unjoined until someone restarted the instance.
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [m("10.0.0.9")] });
    await r.start();
    const s = dgramMock.sockets[0];

    expect(r.refreshAdvertise(baseCfg.advertiseIp, [m("10.0.0.9"), m("192.168.50.2")])).toBe(false);

    expect(s.membership).toEqual(["10.0.0.9", "192.168.50.2"]);
  });

  it("a DHCP change on an interface already in the group does not join it again", async () => {
    // A membership belongs to the interface; joining it again through its new address throws
    // EADDRINUSE on Linux — a warning on every pass.
    const r = new RokuSsdpResponder({
      ...baseCfg,
      bindIp: undefined,
      membershipInterfaces: [{ iface: "eth0", address: "10.0.0.9" }],
    });
    await r.start();
    r.refreshAdvertise("10.0.0.77", [{ iface: "eth0", address: "10.0.0.77" }]);
    expect(dgramMock.sockets[0].membership).toEqual(["10.0.0.9"]);
  });

  it("a receive error is logged and the socket keeps running", async () => {
    // Node reports a recvmsg error as 'error' and the socket goes on receiving (libuv
    // uv__udp_recvmsg, Node dgram onMessage). Closing it would turn a passing hiccup into
    // discovery that stays off until a restart.
    const fatal = vi.fn();
    const r = new RokuSsdpResponder({
      ...baseCfg,
      bindIp: undefined,
      membershipInterfaces: [],
      onFatalError: fatal,
    });
    await r.start();
    const s = dgramMock.sockets[0];
    s.emit("error", new Error("ENOBUFS"));
    s.emit("error", new Error("ENOBUFS"));
    expect(fatal).not.toHaveBeenCalled();
    expect(s.closed).toBe(false);
    // Throttled: one line, not one per error.
    expect(noopLog.warn.mock.calls.filter(c => String(c[0]).includes("SSDP socket error"))).toHaveLength(1);
  });

  it("reports a socket that closed on its own exactly once — not one stop() closed", async () => {
    const fatal = vi.fn();
    const r = new RokuSsdpResponder({
      ...baseCfg,
      bindIp: undefined,
      membershipInterfaces: [],
      onFatalError: fatal,
    });
    await r.start();
    const s = dgramMock.sockets[0];
    s.emit("close");
    s.emit("close");
    expect(fatal).toHaveBeenCalledTimes(1);

    const quiet = vi.fn();
    const r2 = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [], onFatalError: quiet });
    await r2.start();
    r2.stop();
    dgramMock.sockets.at(-1)!.emit("close");
    expect(quiet).not.toHaveBeenCalled();
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
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [m("10.0.0.9")] });
    // One interface out of the multicast routing table must not kill discovery on
    // the others — and a silent failure would leave "no device found" unexplainable.
    await expect(r.start()).resolves.toBeUndefined();
    expect(noopLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("multicast join failed on if-10.0.0.9 (10.0.0.9)"),
    );
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
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [m("10.0.0.9")] });
    await r.start();
    // node-gyp bindings can reject with a bare string; `e.message` would be
    // undefined and the warning would name no cause at all.
    expect(noopLog.warn).toHaveBeenCalledWith(expect.stringContaining("EPERM-ish string"));
  });

  it("a failed egress pin warns but still starts", async () => {
    dgramMock.fail.mcastIf = true;
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: "10.0.0.9", membershipInterfaces: [m("10.0.0.9")] });
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

  it("ignores a search from outside the adapter's networks — no reflection towards a spoofed source", async () => {
    const r = new RokuSsdpResponder({
      ...baseCfg,
      isClientAllowed: (a: string): boolean => a !== "8.8.8.8",
      bindIp: undefined,
      membershipInterfaces: [],
    });
    await r.start();
    const s = dgramMock.sockets[0];
    s.emit("message", Buffer.from(MSEARCH), { address: "8.8.8.8", port: 1900 });
    // The socket listens on every interface; on a host with a public one an answer
    // would go to whatever address the datagram claims to come from.
    expect(s.sent).toEqual([]);
    expect(noopLog.debug).toHaveBeenCalledWith(expect.stringContaining("8.8.8.8 ignored"));
  });

  it("uses the lan guard when no check is handed in", async () => {
    const { isClientAllowed: _unused, ...cfg } = baseCfg;
    const r = new RokuSsdpResponder({ ...cfg, bindIp: undefined, membershipInterfaces: [] });
    await r.start();
    const s = dgramMock.sockets[0];
    s.emit("message", Buffer.from(MSEARCH), { address: "8.8.8.8", port: 1900 });
    expect(s.sent).toEqual([]);
  });

  it("answers each network with the host's address in THAT network", async () => {
    // Multi-homed "all interfaces": a remote in the IoT VLAN must get the host's IoT VLAN
    // address — the primary one may sit behind a firewall it cannot cross.
    const r = new RokuSsdpResponder({
      ...baseCfg,
      bindIp: undefined,
      membershipInterfaces: [],
      advertiseFor: (remote: string) => (remote.startsWith("192.168.50.") ? "192.168.50.2" : undefined),
    });
    await r.start();
    const s = dgramMock.sockets[0];
    s.emit("message", Buffer.from(MSEARCH), { address: "192.168.50.77", port: 1234 });
    s.emit("message", Buffer.from(MSEARCH), { address: "10.0.0.50", port: 1234 });
    expect(s.sent[0].text).toContain("LOCATION: http://192.168.50.2:8060/");
    // No own network matched: the fallback address.
    expect(s.sent[1].text).toContain("LOCATION: http://10.0.0.9:8060/");
  });

  it("a chosen interface answers with its own address only", async () => {
    const r = new RokuSsdpResponder({
      ...baseCfg,
      bindIp: "10.0.0.9",
      membershipInterfaces: [m("10.0.0.9")],
      advertiseFor: () => "192.168.50.2",
    });
    await r.start();
    const s = dgramMock.sockets[0];
    s.emit("message", Buffer.from(MSEARCH), { address: "10.0.0.50", port: 1234 });
    expect(s.sent[0].text).toContain("LOCATION: http://10.0.0.9:8060/");
    // And no per-interface senders: the receiving socket is pinned to the chosen interface.
    expect(dgramMock.sockets).toHaveLength(1);
  });

  it("announces on every interface with that interface's address", async () => {
    const r = new RokuSsdpResponder({
      ...baseCfg,
      bindIp: undefined,
      membershipInterfaces: [m("10.0.0.9"), m("192.168.50.2")],
    });
    await r.start();
    r.announce();
    const [, first, second] = dgramMock.sockets;
    expect(first.sent[0].text).toContain("LOCATION: http://10.0.0.9:8060/");
    expect(second.sent[0].text).toContain("LOCATION: http://192.168.50.2:8060/");
    expect(dgramMock.sockets[0].sent).toEqual([]);
    // The farewell goes out on every interface too, and stop() closes the senders.
    await r.byebye();
    expect(first.sent.at(-1)!.text).toContain("ssdp:byebye");
    expect(second.sent.at(-1)!.text).toContain("ssdp:byebye");
    r.stop();
    expect(dgramMock.sockets.every(x => x.closed)).toBe(true);
  });

  it("drops the sender of an interface that went away", async () => {
    const r = new RokuSsdpResponder({
      ...baseCfg,
      bindIp: undefined,
      membershipInterfaces: [m("10.0.0.9"), m("192.168.50.2")],
    });
    await r.start();
    r.refreshAdvertise(baseCfg.advertiseIp, [m("10.0.0.9")]);
    expect(dgramMock.sockets[2].closed).toBe(true);
    expect(dgramMock.sockets[1].closed).toBe(false);
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

  it("warns when a search answer cannot be sent — once a minute, not once per search", async () => {
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [] });
    await r.start();
    dgramMock.fail.send = true;
    dgramMock.sockets[0].emit("message", Buffer.from(MSEARCH), { address: "10.0.0.50", port: 41234 });
    dgramMock.sockets[0].emit("message", Buffer.from(MSEARCH), { address: "10.0.0.50", port: 41234 });
    // Warn, not throw: the send callback runs outside any try/catch, so an unhandled throw
    // here would take the adapter process down. A remote that keeps searching from an
    // unreachable address (EHOSTUNREACH) must not fill the log.
    expect(noopLog.warn.mock.calls.filter(c => String(c[0]).includes("response send failed"))).toHaveLength(1);
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

  it("a sender whose socket errors later is reported, and the responder keeps running", async () => {
    const log = recordingLog();
    const r = new RokuSsdpResponder({
      ...baseCfg,
      logger: log,
      bindIp: undefined,
      membershipInterfaces: [m("10.0.0.9")],
    });
    await r.start();
    dgramMock.sockets[1].emit("error", new Error("ENETDOWN"));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("SSDP sender on if-10.0.0.9: ENETDOWN"));
    expect(dgramMock.sockets[1].closed).toBe(false);
  });

  it("a sender that cannot pin its interface is reported, not fatal", async () => {
    const log = recordingLog();
    dgramMock.fail.mcastIf = true;
    const r = new RokuSsdpResponder({
      ...baseCfg,
      logger: log,
      bindIp: undefined,
      membershipInterfaces: [m("10.0.0.9")],
    });
    await r.start();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("could not pin its interface: EINVAL"));
  });

  it("a sender that cannot be opened costs only that interface its announcement", async () => {
    const log = recordingLog();
    const r = new RokuSsdpResponder({
      ...baseCfg,
      logger: log,
      bindIp: undefined,
      membershipInterfaces: [m("10.0.0.9")],
    });
    await r.start();
    dgramMock.fail.create = true;
    r.refreshAdvertise(baseCfg.advertiseIp, [m("10.0.0.9"), m("192.168.50.2")]);
    dgramMock.fail.create = false;
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("SSDP sender on if-192.168.50.2 could not open: EMFILE"),
    );
    r.announce();
    expect(dgramMock.sockets[1].sent).toHaveLength(1);
  });

  it("an announce whose socket throws on send is logged at debug, the other devices still go out", async () => {
    const log = recordingLog();
    const r = new RokuSsdpResponder({
      ...baseCfg,
      logger: log,
      devices: [
        { uuid: "a", port: 8060 },
        { uuid: "b", port: 8061 },
      ],
      bindIp: undefined,
      membershipInterfaces: [],
    });
    await r.start();
    dgramMock.fail.sendThrows = true;
    expect(() => r.announce()).not.toThrow();
    // One line per device: the first failure did not end the loop.
    const failed = log.debug.mock.calls.filter(([text]) =>
      String(text).includes("NOTIFY send failed: ERR_SOCKET_DGRAM_NOT_RUNNING"),
    );
    expect(failed).toHaveLength(2);
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

describe("RokuSsdpResponder — the device set changes while it runs", () => {
  beforeEach(() => {
    dgramMock.sockets.length = 0;
    Object.keys(dgramMock.fail).forEach(k => ((dgramMock.fail as Record<string, boolean>)[k] = false));
    vi.clearAllMocks();
  });

  it("owns its list instead of aliasing the caller's array", async () => {
    // The caller's array must not be able to change what is announced behind the
    // responder's back; addDevice/removeDevice are the only doors.
    const devices = [{ uuid: "aaa", port: 8060 }];
    const r = new RokuSsdpResponder({ ...baseCfg, devices, bindIp: undefined, membershipInterfaces: [] });
    await r.start();
    devices.push({ uuid: "bbb", port: 8061 });
    r.announce();
    expect(dgramMock.sockets[0].sent).toHaveLength(1);
  });

  it("announces a device that joined later", async () => {
    const r = new RokuSsdpResponder({
      ...baseCfg,
      devices: [{ uuid: "aaa", port: 8060 }],
      bindIp: undefined,
      membershipInterfaces: [],
    });
    await r.start();
    r.addDevice({ uuid: "bbb", port: 8061 });
    r.announce();
    const sent = dgramMock.sockets[0].sent.map(x => x.text).join("\n");
    expect(sent).toContain("uuid:roku:ecp:bbb");
  });

  it("adds a device only once", async () => {
    const r = new RokuSsdpResponder({
      ...baseCfg,
      devices: [{ uuid: "aaa", port: 8060 }],
      bindIp: undefined,
      membershipInterfaces: [],
    });
    await r.start();
    r.addDevice({ uuid: "aaa", port: 8060 });
    r.announce();
    expect(dgramMock.sockets[0].sent).toHaveLength(1);
  });

  it("stops answering for a device whose server died", async () => {
    // Otherwise discovery keeps pointing remotes at a port nobody serves.
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
    r.removeDevice("aaa");
    dgramMock.sockets[0].emit("message", Buffer.from(MSEARCH), { address: "192.168.1.10", port: 1234 });
    const sent = dgramMock.sockets[0].sent.map(x => x.text).join("\n");
    expect(sent).toContain("uuid:roku:ecp:bbb");
    expect(sent).not.toContain("uuid:roku:ecp:aaa");
  });

  it("removing an unknown device changes nothing", async () => {
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [] });
    await r.start();
    r.removeDevice("nope");
    r.announce();
    expect(dgramMock.sockets[0].sent).toHaveLength(1);
  });

  it("mirrors the search target so a rootdevice sweep does not discard the answer", async () => {
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [] });
    await r.start();
    dgramMock.sockets[0].emit("message", Buffer.from(MSEARCH.replace("ST: roku:ecp", "ST: upnp:rootdevice")), {
      address: "192.168.1.10",
      port: 1234,
    });
    expect(dgramMock.sockets[0].sent[0].text).toContain("ST: upnp:rootdevice");
  });
});

describe("RokuSsdpResponder — the farewell", () => {
  beforeEach(() => {
    dgramMock.sockets.length = 0;
    Object.keys(dgramMock.fail).forEach(k => ((dgramMock.fail as Record<string, boolean>)[k] = false));
    vi.clearAllMocks();
  });

  it("withdraws every device from the multicast group", async () => {
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

    await r.byebye();

    const s = dgramMock.sockets[0];
    expect(s.sent).toHaveLength(2);
    expect(s.sent.map(x => `${x.address}:${x.port}`)).toEqual(["239.255.255.250:1900", "239.255.255.250:1900"]);
    expect(s.sent[0].text).toContain("ssdp:byebye");
    expect(s.sent[0].text).toContain("uuid:roku:ecp:aaa");
  });

  it("resolves — never hangs teardown — when a send fails", async () => {
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [] });
    await r.start();
    dgramMock.fail.send = true;

    await expect(r.byebye()).resolves.toBeUndefined();
    expect(noopLog.debug).toHaveBeenCalledWith(expect.stringContaining("byebye send failed"));
  });

  it("resolves even when the socket throws the moment it is used", async () => {
    // dgram throws ERR_SOCKET_DGRAM_NOT_RUNNING synchronously on a socket that closed
    // under us — teardown must not hang on that, and must not throw out of onUnload.
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [] });
    await r.start();
    dgramMock.sockets[0].send = () => {
      throw new Error("ERR_SOCKET_DGRAM_NOT_RUNNING");
    };

    await expect(r.byebye()).resolves.toBeUndefined();
    expect(noopLog.debug).toHaveBeenCalledWith(expect.stringContaining("byebye send failed"));
  });

  it("resolves immediately when there is no socket or no device left", async () => {
    const r = new RokuSsdpResponder({ ...baseCfg, bindIp: undefined, membershipInterfaces: [] });
    await expect(r.byebye()).resolves.toBeUndefined();
    await r.start();
    r.removeDevice("abc123");
    await expect(r.byebye()).resolves.toBeUndefined();
    expect(dgramMock.sockets[0].sent).toHaveLength(0);
  });
});
