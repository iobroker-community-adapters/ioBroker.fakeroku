import { vi } from "vitest";
import type { CommandEvent } from "../../src/ecp/ecp-command";
import { sanitizeId } from "../../src/lib/pure-helpers";
import { Fakeroku } from "../../src/main";
import { osMock } from "./os-double";

/*
 * Shared harness of the orchestration tests (`src/main.*.test.ts`). `@iobroker/adapter-core` is replaced by
 * `adapter-core-double.ts`, `node:os` by `os-double.ts`; only the two network-facing collaborators (ECP server, SSDP
 * responder) are replaced through the factory seams in main.ts — nothing here binds a port.
 */

/** The ECP server the seam hands out: its options as built by the adapter, start and stop as mocks. */
export interface FakeEcp {
  /** Binds — rejects for the port a test marks as busy. */
  start: ReturnType<typeof vi.fn>;
  /** Closes. */
  stop: ReturnType<typeof vi.fn>;
  /** The configuration the adapter built. */
  options: Record<string, unknown>;
}
/** The SSDP responder the seam hands out: every method a mock, its options as built by the adapter. */
export interface FakeSsdp {
  /** Binds — rejects when a test says port 1900 is busy. */
  start: ReturnType<typeof vi.fn>;
  /** Closes. */
  stop: ReturnType<typeof vi.fn>;
  /** Sends ssdp:alive. */
  announce: ReturnType<typeof vi.fn>;
  /** Follows the host; reports whether the address changed. */
  refreshAdvertise: ReturnType<typeof vi.fn>;
  /** Answers for one more device. */
  addDevice: ReturnType<typeof vi.fn>;
  /** Stops answering for a device. */
  removeDevice: ReturnType<typeof vi.fn>;
  /** Sends the farewell. */
  byebye: ReturnType<typeof vi.fn>;
  /** The configuration the adapter built. */
  options: Record<string, unknown>;
}

/**
 * Let every pending promise chain settle: one macrotask runs after all microtasks queued so far.
 *
 * @returns a promise that resolves on the next macrotask
 */
export function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * Typed access to the private members the orchestration tests drive.
 *
 * @param adapter Adapter instance under test
 * @returns the same instance, typed with what the tests reach into
 */
export function internalOf(adapter: Fakeroku): {
  onReady(): Promise<void>;
  onUnload(cb: () => void): void;
  applyCommand(deviceId: string, cmd: CommandEvent): boolean;
  onSsdpFatal(): void;
  startWithTimeout(p: Promise<void>, ms: number): Promise<void>;
  objects: Map<string, Record<string, unknown>>;
  states: Map<string, { val: unknown; ack: boolean }>;
  enums: Map<string, Set<string>>;
  written: string[];
  config: Record<string, unknown>;
  log: Record<"debug" | "info" | "warn" | "error", ReturnType<typeof vi.fn>>;
  setTimeout: ReturnType<typeof vi.fn>;
  clearTimeout: ReturnType<typeof vi.fn>;
  setInterval: ReturnType<typeof vi.fn>;
  clearInterval: ReturnType<typeof vi.fn>;
  ssdp: FakeSsdp | undefined;
  running: { uuid: string; port: number }[];
  pending: { id: string; name: string }[];
  retryPendingDevices(): Promise<void>;
  devices: Map<string, { keys: ReadonlySet<string>; server?: unknown }>;
  commands: { pulseTimers: Set<unknown>; holdTimers: Map<string, unknown> };
  setState: ReturnType<typeof vi.fn>;
  getStatesAsync: ReturnType<typeof vi.fn>;
  getAdapterObjectsAsync: ReturnType<typeof vi.fn>;
  lastState: Map<string, { val: unknown; ack: boolean; q?: number }>;
  extendObject: ReturnType<typeof vi.fn>;
  setForeignObject: ReturnType<typeof vi.fn>;
  instanceNative: Record<string, unknown>;
  instanceCommon: Record<string, unknown>;
  getForeignObjectAsync: ReturnType<typeof vi.fn>;
  extendForeignObjectAsync: ReturnType<typeof vi.fn>;
  delObjectAsync: ReturnType<typeof vi.fn>;
  deviceManagement: unknown;
  makeEcpServer: unknown;
  makeSsdpResponder: unknown;
} {
  return adapter as never;
}

/** What setup() hands a test: the adapter, typed access to its internals, and the fakes it built. */
export interface Ctx {
  /** The adapter under test. */
  adapter: Fakeroku;
  /** Typed access to its private members and the double's store. */
  i: ReturnType<typeof internalOf>;
  /** Every ECP server the adapter built, in order. */
  ecp: FakeEcp[];
  /** Every SSDP responder the adapter built, in order. */
  ssdps: FakeSsdp[];
  /** Release the blocked ECP port — what a restart race looks like a minute later. */
  freeEcpPort: () => void;
}

/**
 * A fake ECP server.
 *
 * @param options the configuration the adapter built
 * @param start what its bind does
 * @returns the fake
 */
export function fakeEcp(options: Record<string, unknown>, start: () => Promise<void>): FakeEcp {
  return { options, stop: vi.fn(), start: vi.fn(start) };
}

/**
 * A fake SSDP responder. Like the real one it reports from refreshAdvertise whether the advertised address changed.
 *
 * @param options the configuration the adapter built
 * @param start what its bind does
 * @returns the fake
 */
export function fakeSsdp(options: Record<string, unknown>, start: () => Promise<void>): FakeSsdp {
  return {
    options,
    stop: vi.fn(),
    announce: vi.fn(),
    refreshAdvertise: vi.fn((ip: string) => {
      const changed = ip !== (options.advertiseIp as string);
      options.advertiseIp = ip;
      return changed;
    }),
    addDevice: vi.fn(),
    removeDevice: vi.fn(),
    byebye: vi.fn(() => Promise.resolve()),
    start: vi.fn(start),
  };
}

/**
 * A bind that settles only when the test says so — the way a slow start looks from the adapter.
 *
 * @returns the start function to hand to a fake, and the trigger that lets it resolve
 */
export function deferredStart(): { start: () => Promise<void>; release: () => void } {
  let release: () => void = () => {};
  return {
    start: () =>
      new Promise<void>(resolve => {
        release = resolve;
      }),
    release: () => release(),
  };
}

/**
 * Build an adapter with fake collaborators and a config.
 *
 * @param config native config fields for this run
 * @param opts   per-fake behaviour (which ECP port fails to start, SSDP failure)
 * @param opts.failEcpPort ECP port whose fake server fails to start
 * @param opts.ssdpStartFails Whether the fake SSDP responder fails to start
 * @param opts.fresh A fresh installation: no device object exists yet for the configured rows
 */
export function setup(
  config: Record<string, unknown> = {},
  opts: { failEcpPort?: number; ssdpStartFails?: boolean; fresh?: boolean } = {},
): Ctx {
  // The default config chooses 192.168.1.5 — an interface has to carry it, or the adapter
  // (rightly) waits for it and then refuses to serve an address the host does not have.
  osMock.interfaces ??= {
    eth0: [{ family: "IPv4", address: "192.168.1.5", internal: false, cidr: "192.168.1.5/24" }],
  };
  const adapter = new Fakeroku();
  const i = internalOf(adapter);
  i.config = {
    devices: [{ name: "Wohnzimmer", port: 8060, type: "player" }],
    bind: "192.168.1.5",
    ...config,
  };
  // Same content in the instance object: that is where js-controller keeps it and where the
  // key-migration looks.
  i.instanceNative = structuredClone(i.config);
  // An EXISTING installation unless a test says otherwise: every configured row already has its
  // device object, so it has been announced and keeps the identity it has. On a fresh
  // installation a row without a usable stored uuid gets its own identity and the adapter restarts.
  if (!opts.fresh && Array.isArray(i.config.devices)) {
    for (const row of i.config.devices as { name?: unknown; uuid?: unknown }[]) {
      if (row && typeof row.name === "string" && row.name.trim()) {
        const id = sanitizeId(row.name);
        if (id !== "info" && !i.objects.has(id)) {
          i.objects.set(id, { type: "device", common: { name: row.name }, native: {} });
        }
      }
    }
  }

  const ecp: FakeEcp[] = [];
  const ssdps: FakeSsdp[] = [];
  i.makeEcpServer = (options: Record<string, unknown>) => {
    const port = (options.device as { port: number }).port;
    const server = fakeEcp(options, () =>
      opts.failEcpPort === port ? Promise.reject(new Error(`EADDRINUSE ${port}`)) : Promise.resolve(),
    );
    ecp.push(server);
    return server;
  };
  i.makeSsdpResponder = (options: Record<string, unknown>) => {
    const responder = fakeSsdp(options, () =>
      opts.ssdpStartFails ? Promise.reject(new Error("port 1900 busy")) : Promise.resolve(),
    );
    ssdps.push(responder);
    return responder;
  };
  return {
    adapter,
    i,
    ecp,
    ssdps,
    freeEcpPort: () => {
      opts.failEcpPort = undefined;
    },
  };
}

/**
 * The private members the tests reach through {@link internalOf}, read once with element access: TypeScript checks
 * element access against the real members, so renaming one breaks the type check instead of turning a test into one
 * that reads `undefined` and stays green.
 *
 * @param adapter the adapter
 * @returns the members (unused — the point is the type check)
 */
export function privateMembersExist(adapter: Fakeroku): unknown[] {
  return [
    adapter["onReady"],
    adapter["onUnload"],
    adapter["applyCommand"],
    adapter["onSsdpFatal"],
    adapter["startWithTimeout"],
    adapter["ssdp"],
    adapter["running"],
    adapter["pending"],
    adapter["retryPendingDevices"],
    adapter["devices"],
    adapter["commands"],
    adapter["lastState"],
    adapter["deviceManagement"],
    adapter["makeEcpServer"],
    adapter["makeSsdpResponder"],
  ];
}

/**
 * The host says stop the moment the adapter writes the object with this id — the stop arrives in the middle of
 * the start, exactly where that write sits.
 *
 * @param ctx the test context
 * @param id the object id (relative) whose write triggers the stop
 */
export function stopWhenWriting(ctx: Ctx, id: string): void {
  const real = ctx.i.extendObject.getMockImplementation() as (id: string, o: unknown) => Promise<void>;
  ctx.i.extendObject.mockImplementation((written: string, o: unknown) => {
    if (written === id) {
      ctx.i.onUnload(() => {});
    }
    return real(written, o);
  });
}

/** One player in the kitchen on 8061 — the port the retry tests mark as busy. */
export function kueche(): { name: string; port: number; type: string } {
  return { name: "Kueche", port: 8061, type: "player" };
}

/** Two players: Wohnzimmer on 8060 and Kueche on 8061. */
export function twoPlayers(): { devices: { name: string; port: number; type: string }[] } {
  return { devices: [{ name: "Wohnzimmer", port: 8060, type: "player" }, kueche()] };
}

/** A host without a routable IPv4 yet — only loopback (a Wi-Fi or DHCP that comes up after ioBroker). */
export function noAddressYet(): void {
  osMock.interfaces = { lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }] };
}

/**
 * The callback of the timer the adapter armed last.
 *
 * @param ctx the test context
 * @returns the callback, to fire it by hand
 */
export function lastTimer(ctx: Ctx): () => void {
  return ctx.i.setTimeout.mock.calls.at(-1)![0] as () => void;
}

/**
 * The callback of the first timer the adapter armed with this delay.
 *
 * @param ctx the test context
 * @param ms the delay the timer was armed with
 * @returns the callback, to fire it by hand
 */
export function timerFor(ctx: Ctx, ms: number): () => void {
  return ctx.i.setTimeout.mock.calls.find(([, delay]) => delay === ms)?.[0] as () => void;
}

/** Reset what a test may have changed in the shared doubles — every test file registers it with afterEach. */
export function resetHarness(): void {
  osMock.interfaces = null;
  vi.restoreAllMocks();
}
