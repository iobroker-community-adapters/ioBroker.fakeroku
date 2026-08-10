import { RokuSsdpResponder } from "./ssdp-responder";

// dgram is mocked so the interface handling in start() (per-interface addMembership +
// setMulticastInterface) and the runtime socket-death path are unit-testable without a
// real socket. Follows the govee-lan-client mock shape.
const dgramMock = vi.hoisted(() => {
  interface FakeSocket {
    membership: Array<string | undefined>;
    mcastIf: string[];
    closed: boolean;
    handlers: Record<string, Array<(...a: unknown[]) => void>>;
    once: (ev: string, cb: (...a: unknown[]) => void) => FakeSocket;
    on: (ev: string, cb: (...a: unknown[]) => void) => FakeSocket;
    removeListener: (ev: string, cb: (...a: unknown[]) => void) => FakeSocket;
    bind: (port: unknown, cb?: () => void) => FakeSocket;
    addMembership: (addr: string, iface?: string) => void;
    setMulticastInterface: (iface: string) => void;
    send: (...args: unknown[]) => void;
    close: () => void;
    emit: (ev: string, ...args: unknown[]) => void;
  }
  const sockets: FakeSocket[] = [];
  const make = (): FakeSocket => {
    const s: FakeSocket = {
      membership: [],
      mcastIf: [],
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
        if (typeof cb === "function") cb();
        return s;
      },
      addMembership: (_addr, iface) => {
        s.membership.push(iface);
      },
      setMulticastInterface: iface => {
        s.mcastIf.push(iface);
      },
      send: (...args) => {
        const cb = args[args.length - 1];
        if (typeof cb === "function") (cb as () => void)();
      },
      close: () => {
        s.closed = true;
      },
      emit: (ev, ...args) => {
        (s.handlers[ev] ?? []).forEach(h => h(...args));
      },
    };
    sockets.push(s);
    return s;
  };
  return { sockets, make };
});
vi.mock("node:dgram", () => ({ createSocket: () => dgramMock.make() }));

const noopLog = { debug: (): void => {}, warn: (): void => {}, error: (): void => {} };
const baseCfg = { devices: [{ uuid: "abc123", port: 8060 }], advertiseIp: "10.0.0.9", logger: noopLog };

describe("RokuSsdpResponder", () => {
  beforeEach(() => {
    dgramMock.sockets.length = 0;
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
});
