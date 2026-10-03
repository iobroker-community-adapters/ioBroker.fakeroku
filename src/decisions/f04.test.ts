// Guard of F-04 (krobi 2026-09-03 08:52, "then do it that way, build it in"): fakeroku takes commands and searches only from
// its own networks — over IPv6 too, with an address from the own network; everything else stays out. Checked where
// fakeroku hands the rule to its ECP server (commands) and its SSDP responder (searches). Sealed in the register — a
// change goes through the Werkbank.
import { describe, expect, it, vi } from "vitest";
// The adapter runtime without js-controller: an inline stand-in for @iobroker/adapter-core that keeps objects, states
// and the instance object in maps, managed timers that fire only when a test fires them, and a log of spies. The device
// manager (dm-utils) and the host's network cards are replaced too; the ECP servers and the SSDP responder through the
// adapter's own construction seams.
vi.mock("@iobroker/adapter-core", () => {
  type Obj = Record<string, unknown>;
  class Adapter {
    public namespace = "fakeroku.0";
    public adapterDir = "/tmp/fakeroku";
    public config: Obj = {};
    public objects = new Map<string, Obj>();
    public states = new Map<string, { val: unknown; ack: boolean }>();
    public instance: { common: Obj; native: Obj } = { common: {}, native: {} };
    public nativeWrites: Obj[] = [];
    public stateWrites: string[] = [];
    public timers: { cb: () => void; ms: number }[] = [];
    public log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    public terminate = vi.fn();
    public constructor(_options: unknown) {}
    public on(): void {}
    private rel(id: string): string {
      return id.startsWith(`${this.namespace}.`) ? id.slice(this.namespace.length + 1) : id;
    }
    public setTimeout(cb: () => void, ms: number): unknown {
      const t = { cb, ms };
      this.timers.push(t);
      return t;
    }
    public clearTimeout(): void {}
    public setInterval(cb: () => void, ms: number): unknown {
      return { cb, ms };
    }
    public clearInterval(): void {}
    public getForeignObjectAsync(id: string): Promise<unknown> {
      return Promise.resolve(id === `system.adapter.${this.namespace}` ? structuredClone(this.instance) : null);
    }
    public extendForeignObjectAsync(_id: string, obj: { common?: Obj; native?: Obj }): Promise<void> {
      this.nativeWrites.push(structuredClone(obj));
      Object.assign(this.instance.native, obj.native ?? {});
      Object.assign(this.instance.common, obj.common ?? {});
      return Promise.resolve();
    }
    public getObjectListAsync(): Promise<unknown> {
      const rows = [...this.objects].map(([id, value]) => ({
        id: `${this.namespace}.${id}`,
        value: structuredClone(value),
      }));
      return Promise.resolve({ rows });
    }
    public getAdapterObjectsAsync(): Promise<unknown> {
      return Promise.resolve(
        Object.fromEntries([...this.objects].map(([id, value]) => [`${this.namespace}.${id}`, structuredClone(value)])),
      );
    }
    public getStatesAsync(): Promise<unknown> {
      return Promise.resolve(
        Object.fromEntries([...this.states].map(([id, s]) => [`${this.namespace}.${id}`, { ...s, q: 0 }])),
      );
    }
    public setState(id: string, s: { val: unknown; ack: boolean }): Promise<void> {
      const key = this.rel(id);
      this.states.set(key, { val: s.val, ack: s.ack });
      this.stateWrites.push(key);
      return Promise.resolve();
    }
    public extendObject(id: string, obj: Obj): Promise<void> {
      const key = this.rel(id);
      this.objects.set(key, { ...(this.objects.get(key) ?? {}), ...structuredClone(obj) });
      return Promise.resolve();
    }
    public setForeignObject(id: string, obj: Obj): Promise<void> {
      this.objects.set(this.rel(id), structuredClone(obj));
      return Promise.resolve();
    }
    public delObjectAsync(id: string, options?: { recursive?: boolean }): Promise<void> {
      const key = this.rel(id);
      for (const k of [...this.objects.keys()]) {
        if (k === key || (options?.recursive && k.startsWith(`${key}.`))) {
          this.objects.delete(k);
          this.states.delete(k);
        }
      }
      return Promise.resolve();
    }
  }
  const I18n = {
    init: (): Promise<void> => Promise.resolve(),
    getTranslatedObject: (key: string): unknown => ({ en: key }),
    translate: (key: string): string => key,
  };
  return { Adapter, I18n, default: { Adapter, I18n } };
});
vi.mock("../device-management", () => ({ FakerokuDeviceManagement: class {} }));
vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  const networkInterfaces = (): unknown => ({
    eth0: [
      { address: "192.168.1.5", family: "IPv4", internal: false, cidr: "192.168.1.5/24", netmask: "255.255.255.0" },
      { address: "2003:e1:1f28:9a00::5", family: "IPv6", internal: false, cidr: "2003:e1:1f28:9a00::5/64" },
    ],
  });
  return { ...actual, default: { ...actual, networkInterfaces }, networkInterfaces };
});
import { Fakeroku } from "../main";

/** What a guard reaches in the adapter under test: its private start, its stand-in maps and spies. */
interface Run {
  onReady(): Promise<void>;
  config: Record<string, unknown>;
  log: Record<"debug" | "info" | "warn" | "error", ReturnType<typeof vi.fn>>;
  terminate: ReturnType<typeof vi.fn>;
  objects: Map<string, Record<string, unknown>>;
  states: Map<string, { val: unknown; ack: boolean }>;
  instance: { common: Record<string, unknown>; native: Record<string, unknown> };
  nativeWrites: Record<string, unknown>[];
  stateWrites: string[];
  timers: { cb: () => void; ms: number }[];
  makeEcpServer: (options: Record<string, unknown>) => unknown;
  makeSsdpResponder: (options: Record<string, unknown>) => unknown;
}

/** The fakes the seams hand out. */
interface Fakes {
  ecp: { options: Record<string, unknown> }[];
  ssdp: { options: Record<string, unknown> }[];
  busyPorts: Set<number>;
  ssdpFails: { value: boolean };
}

/**
 * An adapter with a stored configuration, its fakes wired into the seams.
 *
 * @param native the instance's settings
 * @param opts the busy ECP ports and whether discovery fails to start
 * @param opts.busy ECP ports a server cannot bind
 * @param opts.ssdpFails whether port 1900 cannot be bound
 * @returns the adapter's reachable members and the fakes
 */
function adapterWith(
  native: Record<string, unknown>,
  opts: { busy?: number[]; ssdpFails?: boolean } = {},
): { run: Run; fakes: Fakes } {
  const run = new Fakeroku() as unknown as Run;
  run.config = structuredClone(native);
  run.instance.native = structuredClone(native);
  const fakes: Fakes = {
    ecp: [],
    ssdp: [],
    busyPorts: new Set(opts.busy ?? []),
    ssdpFails: { value: opts.ssdpFails ?? false },
  };
  run.makeEcpServer = options => {
    const port = (options.device as { port: number }).port;
    const server = {
      options,
      start: (): Promise<void> =>
        fakes.busyPorts.has(port)
          ? Promise.reject(Object.assign(new Error(`listen EADDRINUSE 0.0.0.0:${port}`), { code: "EADDRINUSE" }))
          : Promise.resolve(),
      stop: (): void => {},
    };
    fakes.ecp.push(server);
    return server;
  };
  run.makeSsdpResponder = options => {
    const responder = {
      options,
      start: (): Promise<void> =>
        fakes.ssdpFails.value ? Promise.reject(new Error("bind EADDRINUSE 0.0.0.0:1900")) : Promise.resolve(),
      stop: (): void => {},
      announce: (): void => {},
      refreshAdvertise: (): boolean => false,
      addDevice: (): void => {},
      removeDevice: (): void => {},
      byebye: (): Promise<void> => Promise.resolve(),
    };
    fakes.ssdp.push(responder);
    return responder;
  };
  return { run, fakes };
}

describe("F-04 — commands and searches only from the own networks, IPv6 included", () => {
  it("hands the ECP server and the SSDP responder the own-network rule", async () => {
    const { run, fakes } = adapterWith({
      bind: "0.0.0.0",
      devices: [
        {
          name: "Wohnzimmer",
          port: 8060,
          type: "player",
          uuid: "0123456789abcdef0123456789abcd01",
          objectId: "Wohnzimmer",
        },
      ],
    });
    await run.onReady();
    const commands = fakes.ecp[0].options.isClientAllowed as (peer: string | undefined) => boolean;
    const searches = fakes.ssdp[0].options.isClientAllowed as (peer: string) => boolean;
    for (const [what, allowed] of [
      ["commands", commands],
      ["searches", searches],
    ] as const) {
      for (const peer of ["192.168.1.77", "::ffff:192.168.1.77", "2003:e1:1f28:9a00::42"]) {
        expect(allowed(peer), `${what} from ${peer}`).toBe(true);
      }
      for (const peer of ["8.8.8.8", "192.168.2.10", "2003:e1:1f28:9a01::42"]) {
        expect(allowed(peer), `${what} from ${peer}`).toBe(false);
      }
    }
  });
});
