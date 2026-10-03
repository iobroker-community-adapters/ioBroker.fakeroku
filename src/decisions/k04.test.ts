// Guard of K4 (krobi 2026-10-03 00:02, "then they have to be given one now, otherwise it's a mess"): a device from
// before 0.7.0 without a type gets it written into the settings ONCE — read from its tree (TV keys there make it a TV);
// no later start derives it again. Sealed in the register — a change goes through the Werkbank.
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

describe("K4 — the type of a row without one is written once", () => {
  it("writes the type the tree shows, restarts once, and the next start writes nothing", async () => {
    const native = { bind: "0.0.0.0", devices: [{ name: "TV", port: 9093, uuid: "legacy-tv" }] };
    const { run, fakes } = adapterWith(native);
    run.objects.set("TV", { type: "device", common: { name: "TV" }, native: {} });
    run.objects.set("TV.keys.VolumeUp", { type: "state", common: { name: "VolumeUp" }, native: {} });

    await run.onReady();

    expect(run.nativeWrites).toHaveLength(1);
    expect((run.instance.native.devices as Record<string, unknown>[])[0]).toMatchObject({ name: "TV", type: "tv" });
    expect(fakes.ecp).toHaveLength(0);

    run.config = structuredClone(run.instance.native);
    await run.onReady();

    expect(run.nativeWrites).toHaveLength(1);
    expect(fakes.ecp[0].options.deviceType).toBe("tv");
  });
});
