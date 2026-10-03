// Guard of F-08 (krobi 2026-10-03 00:14 / 00:17 / 00:18 / 00:36): green means everything runs, yellow means something is
// wrong and a part runs, red is only a process that is gone — no Roku configured or none running is yellow with a line,
// the instance stays up for the device manager; a busy port, a dead server and a failed discovery are retried every
// minute; there is no datapoint per Roku. Every problem writes one line with its likely cause when it first occurs,
// repeats only on debug, and one info line when it works again. Sealed in the register — a change goes through the
// Werkbank.
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

/**
 * Fire the minute retry the adapter armed last and let it finish.
 *
 * @param run the adapter
 */
async function fireRetry(run: Run): Promise<void> {
  const timer = [...run.timers].reverse().find(t => t.ms === 60_000);
  expect(timer, "a retry every minute is armed").toBeDefined();
  run.timers.splice(run.timers.indexOf(timer!), 1);
  timer!.cb();
  for (let n = 0; n < 20; n++) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

const connection = (run: Run): unknown => run.states.get("info.connection")?.val;
const two = {
  bind: "0.0.0.0",
  devices: [
    {
      name: "Wohnzimmer",
      port: 8060,
      type: "player",
      uuid: "0123456789abcdef0123456789abcd01",
      objectId: "Wohnzimmer",
    },
    { name: "Kueche", port: 8061, type: "tv", uuid: "0123456789abcdef0123456789abcd02", objectId: "Kueche" },
  ],
};

describe("F-08 — green, yellow, and no datapoint per Roku", () => {
  it("is green while every Roku and discovery run", async () => {
    const { run } = adapterWith(two);
    await run.onReady();
    expect(connection(run)).toBe(true);
  });

  it("is yellow while a port is busy, retries every minute, and green once it is free", async () => {
    const { run, fakes } = adapterWith(two, { busy: [8061] });
    await run.onReady();
    expect(connection(run)).toBe(false);
    fakes.busyPorts.clear();
    await fireRetry(run);
    expect(connection(run)).toBe(true);
  });

  it("is yellow while a server that died runs no more, retries every minute, and green once it is back", async () => {
    const { run, fakes } = adapterWith(two);
    await run.onReady();
    (fakes.ecp[1].options.onFatalError as (err: Error) => void)(new Error("network gone"));
    await new Promise(resolve => setImmediate(resolve));
    expect(connection(run)).toBe(false);
    await fireRetry(run);
    expect(connection(run)).toBe(true);
  });

  it("is yellow while discovery cannot start, retries every minute, and green once it runs", async () => {
    const { run, fakes } = adapterWith(two, { ssdpFails: true });
    await run.onReady();
    expect(connection(run)).toBe(false);
    fakes.ssdpFails.value = false;
    await fireRetry(run);
    expect(connection(run)).toBe(true);
  });

  it("is yellow while the chosen address is missing on the host", async () => {
    const { run } = adapterWith({ ...two, bind: "192.0.2.1" });
    await run.onReady();
    expect(connection(run)).toBe(false);
    expect(run.terminate).not.toHaveBeenCalled();
  });

  it("no Roku configured: yellow, one line asking to add one, and the process stays", async () => {
    const { run } = adapterWith({ bind: "0.0.0.0", devices: [] });
    await run.onReady();
    expect(connection(run)).toBe(false);
    expect(run.log.error).toHaveBeenCalledWith(
      "No Roku device configured — add one in the instance settings (device manager)",
    );
    expect(run.terminate).not.toHaveBeenCalled();
  });

  it("no Roku running: yellow, one line naming each with its reason, and the process stays", async () => {
    const { run } = adapterWith(two, { busy: [8060, 8061] });
    await run.onReady();
    expect(connection(run)).toBe(false);
    const lines = run.log.error.mock.calls.map(([text]) => String(text));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^No emulated Roku is running — "Wohnzimmer": port 8060 .* · "Kueche": port 8061 /);
    expect(run.terminate).not.toHaveBeenCalled();
  });

  it("creates no datapoint per Roku that shows whether it runs", async () => {
    const { run } = adapterWith(two, { busy: [8061] });
    await run.onReady();
    for (const device of ["Wohnzimmer", "Kueche"]) {
      const children = [...run.objects.keys()].filter(id => id.startsWith(`${device}.`)).map(id => id.split(".")[1]);
      expect(new Set(children), device).toEqual(new Set(["command", "keys"]));
    }
    const status = [...run.objects.keys()].filter(id => !id.startsWith("Wohnzimmer") && !id.startsWith("Kueche"));
    expect(
      status.every(id => id === "info" || id === "info.connection"),
      status.join(", "),
    ).toBe(true);
  });
});

/**
 * The lines above debug the adapter wrote since the spies were last cleared.
 *
 * @param run the adapter
 * @returns level and text of each
 */
function loud(run: Run): string[] {
  return (["info", "warn", "error"] as const).flatMap(level =>
    run.log[level].mock.calls.map(([text]) => `${level}: ${String(text)}`),
  );
}

/**
 * Forget the lines written so far.
 *
 * @param run the adapter
 */
function quiet(run: Run): void {
  for (const level of ["debug", "info", "warn", "error"] as const) {
    run.log[level].mockClear();
  }
}

describe("F-08 — one line with the cause, repeats on debug, one info line on the return", () => {
  it("a busy port", async () => {
    const { run, fakes } = adapterWith(two, { busy: [8061] });
    await run.onReady();
    const first = loud(run).filter(line => !line.startsWith("info: Emulating"));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(/^warn: .*"Kueche".*port 8061 is already in use/);

    quiet(run);
    await fireRetry(run);
    expect(loud(run)).toEqual([]);

    fakes.busyPorts.clear();
    await fireRetry(run);
    expect(loud(run)).toEqual(['info: Emulated Roku "Kueche" is listening on port 8061 again.']);
  });

  it("a server that died", async () => {
    const { run, fakes } = adapterWith(two);
    await run.onReady();
    quiet(run);
    (fakes.ecp[1].options.onFatalError as (err: Error) => void)(new Error("network gone"));
    expect(loud(run)).toHaveLength(1);
    expect(loud(run)[0]).toMatch(/^error: .*"Kueche".*network gone/);

    quiet(run);
    fakes.busyPorts.add(8061);
    await fireRetry(run);
    expect(loud(run)).toEqual([]);

    fakes.busyPorts.clear();
    await fireRetry(run);
    expect(loud(run)).toEqual(['info: Emulated Roku "Kueche" is listening on port 8061 again.']);
  });

  it("discovery that cannot start", async () => {
    const { run, fakes } = adapterWith(two, { ssdpFails: true });
    await run.onReady();
    const first = loud(run).filter(line => !line.startsWith("info: Emulating"));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(/^warn: SSDP discovery unavailable: bind EADDRINUSE/);

    quiet(run);
    await fireRetry(run);
    expect(loud(run)).toEqual([]);

    fakes.ssdpFails.value = false;
    await fireRetry(run);
    expect(loud(run)).toEqual(["info: SSDP discovery is running again — remotes can find the emulated Rokus."]);
  });

  it("a chosen address the host does not carry", async () => {
    const { run } = adapterWith({ ...two, bind: "192.0.2.1" });
    await run.onReady();
    const first = loud(run).filter(line => !line.startsWith("info: Emulating"));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(/^warn: Address 192\.0\.2\.1 does not exist on this host/);
  });
});
