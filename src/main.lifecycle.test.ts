import type { CommandEvent } from "./ecp/ecp-command";
import { vi } from "vitest";
import type * as OsModule from "node:os";

/**
 * Orchestration tests of the adapter — The lifecycle: collaborator wiring, retries of a busy port, the stop at every point of the start, unload and farewell, compact mode, and the paths only a failing database reaches.
 * Shared doubles and harness: `test/helpers/`.
 */
vi.mock("@iobroker/adapter-core", () => vi.importActual("../test/helpers/adapter-core-double"));
vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof OsModule>();
  const { osMock } = await vi.importActual<{ osMock: { interfaces: Record<string, unknown[]> | null } }>(
    "../test/helpers/os-double",
  );
  const networkInterfaces = (): unknown => osMock.interfaces ?? actual.networkInterfaces();
  return { ...actual, default: { ...actual, networkInterfaces }, networkInterfaces };
});

import { I18n } from "@iobroker/adapter-core";
import { FakerokuDeviceManagement } from "./device-management";
import * as mainModule from "./main";
import { Fakeroku } from "./main";
import { EcpHttpServer } from "./ecp/ecp-http-server";
import { RokuSsdpResponder } from "./discovery/ssdp-responder";
import { deriveUuid } from "./lib/device-identity";
import {
  setup,
  settle,
  internalOf,
  type Ctx,
  type FakeEcp,
  type FakeSsdp,
  resetHarness,
  noAddressYet,
  timerFor,
  stopWhenWriting,
  twoPlayers,
  kueche,
  fakeEcp,
  fakeSsdp,
  deferredStart,
} from "../test/helpers/fakeroku-harness";
import { osMock } from "../test/helpers/os-double";

afterEach(resetHarness);

describe("Fakeroku collaborator wiring", () => {
  it("wires the device manager — only once the translations are loaded", async () => {
    // Nothing else in the adapter ever reads this field — it exists purely for its constructor's
    // side effect of registering the manager, so dropping it would leave the admin's device list
    // dead while lint and tsc stay green. It must come AFTER I18n.init: js-controller delivers
    // messages before `ready`, and a card text built before the translations are loaded throws.
    const ctx = setup();
    let builtBeforeInit: unknown = "not called";
    vi.mocked(I18n.init).mockImplementationOnce(() => {
      builtBeforeInit = ctx.i.deviceManagement;
      return Promise.resolve();
    });
    expect(ctx.i.deviceManagement).toBeUndefined();
    await ctx.i.onReady();
    expect(builtBeforeInit).toBeUndefined();
    expect(ctx.i.deviceManagement).toBeInstanceOf(FakerokuDeviceManagement);
  });

  it("builds the real collaborators when nothing replaces the seams", () => {
    // The seams exist only for these tests. If they ever pointed at the wrong
    // class, every test here would still pass while production started nothing.
    const i = internalOf(new Fakeroku());
    const make = i.makeEcpServer as (o: unknown) => unknown;
    const makeSsdp = i.makeSsdpResponder as (o: unknown) => unknown;
    expect(make({ device: { uuid: "a", port: 8060 } })).toBeInstanceOf(EcpHttpServer);
    expect(makeSsdp({ devices: [], membershipInterfaces: [] })).toBeInstanceOf(RokuSsdpResponder);
  });

  it("routes each ECP server's commands to ITS OWN device", async () => {
    const ctx = setup(twoPlayers());
    await ctx.i.onReady();
    const onCommand = ctx.ecp[1].options.onCommand as (c: CommandEvent) => void;
    onCommand({ type: "keypress", key: "Home" });
    // A shared or mis-captured deviceId here makes every remote control the first
    // Roku — the classic loop-variable capture bug, invisible with one device.
    expect(ctx.i.states.get("Kueche.command")).toEqual({ val: "Home", ack: true });
    // Not "has no state": creating the object seeds common.def, so the other device's
    // command exists and sits at its empty default. Untouched is the rule, not absent.
    expect(ctx.i.states.get("Wohnzimmer.command")).toEqual({ val: "", ack: true });
  });

  it("hooks the responder's fatal callback to the announce shutdown", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.clearInterval.mockClear();
    const onFatal = ctx.ssdps[0].options.onFatalError as () => void;
    onFatal();
    // Without this wiring the announce interval keeps firing into a dead socket
    // for as long as the instance runs.
    expect(ctx.i.clearInterval).toHaveBeenCalledTimes(1);
    expect(ctx.i.ssdp).toBeUndefined();
  });

  it("hooks each ECP server's fatal callback to the connection status", async () => {
    // A server that dies after a good start leaves a device answering nothing. Without
    // this wiring info.connection stays true — a green instance in front of a Roku that
    // is gone, which nobody would notice. The SSDP responder has had the same callback
    // since 1.1.0; the ECP servers only logged.
    const ctx = setup({ devices: [{ name: "Wohnzimmer", port: 8060, type: "player" }] });
    await ctx.i.onReady();
    expect(ctx.i.states.get("info.connection")?.val).toBe(true);

    const onFatal = ctx.ecp[0].options.onFatalError as () => void;
    expect(onFatal, "the ECP server's fatal callback must be wired").toBeDefined();
    onFatal();

    expect(ctx.i.states.get("info.connection")?.val).toBe(false);
    expect(ctx.i.log.error).toHaveBeenCalledWith(expect.stringContaining('"Wohnzimmer" stopped answering'));
    // And the dead server is CLOSED, not merely forgotten. Once it is out of the map
    // nothing can reach it again — not even onUnload — so in compact mode its port would
    // stay taken for the lifetime of the shared host process.
    expect(ctx.ecp[0].stop).toHaveBeenCalledTimes(1);
  });

  it("survives a failing status write when a device dies", async () => {
    // onEcpFatal runs from a socket event, outside any await. An unhandled rejection
    // there is an adapter crash (exit code 6) over a state write that failed because
    // the database is already going down — the very moment this path fires.
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.setState.mockRejectedValueOnce(new Error("states db closed"));

    const onFatal = ctx.ecp[0].options.onFatalError as () => void;
    expect(() => onFatal()).not.toThrow();
    await settle();

    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("states db closed"));
  });

  it("a fatal report with no announce running does not touch the timer API", async () => {
    const ctx = setup({}, { ssdpStartFails: true });
    await ctx.i.onReady();
    ctx.i.clearInterval.mockClear();
    ctx.i.onSsdpFatal();
    // clearInterval(undefined) is a js-controller warning per call, not a no-op.
    expect(ctx.i.clearInterval).not.toHaveBeenCalled();
  });
});

describe("Fakeroku startWithTimeout", () => {
  it("rejects when the start does not settle in time", async () => {
    const ctx = setup();
    // The stub's setTimeout does not fire on its own — invoke the callback the
    // way the runtime would once the deadline passes.
    const never = new Promise<void>(() => {});
    const bounded = ctx.i.startWithTimeout(never, 500);
    const armed = ctx.i.setTimeout.mock.calls.at(-1)!;
    (armed[0] as () => void)();
    await expect(bounded).rejects.toThrow(/timed out after 500/);
  });

  it("clears the deadline when the start succeeds", async () => {
    const ctx = setup();
    ctx.i.clearTimeout.mockClear();
    await ctx.i.startWithTimeout(Promise.resolve(), 500);
    expect(ctx.i.clearTimeout).toHaveBeenCalledTimes(1);
  });
});

describe("Fakeroku — a device whose port was busy is retried", () => {
  it("queues the device, arms a timer and leaves the others running", async () => {
    const ctx = setup(twoPlayers(), { failEcpPort: 8061 });
    await ctx.i.onReady();

    expect(ctx.i.pending.map(p => p.name)).toEqual(["Kueche"]);
    expect(ctx.i.running).toHaveLength(1);
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
    // The objects of the waiting device exist — only its server is missing.
    expect(ctx.i.objects.has("Kueche.keys.Home")).toBe(true);
    expect(ctx.i.setTimeout).toHaveBeenCalledWith(expect.any(Function), 60_000);
  });

  it("brings the device up on the retry and announces it from then on", async () => {
    const ctx = setup({ devices: [kueche()] }, { failEcpPort: 8061 });
    await ctx.i.onReady();
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });

    // The port is free now — what a restart race looks like a minute later.
    ctx.freeEcpPort();
    await ctx.i.retryPendingDevices();

    expect(ctx.i.pending).toHaveLength(0);
    expect(ctx.i.running).toHaveLength(1);
    expect(ctx.i.states.get("info.connection")).toEqual({ val: true, ack: true });
    expect(ctx.i.log.info).toHaveBeenCalledWith(expect.stringContaining("is listening on port 8061 again"));
    // Discovery never started (nothing was listening) — the recovery brings it up.
    expect(ctx.ssdps).toHaveLength(1);
  });

  it("re-arms after a retry that failed again — a busy port must not go quiet", async () => {
    // Only reachable through the real callback. Calling retryPendingDevices() directly
    // leaves retryTimer set from onReady, so scheduleDeviceRetry returns early and the
    // re-arm is never exercised — the timer callback clearing retryTimer BEFORE calling is
    // the whole mechanism. Without it a device whose second attempt fails is never tried
    // again, and the only way back is restarting the instance by hand.
    const ctx = setup({ devices: [kueche()] }, { failEcpPort: 8061 });
    await ctx.i.onReady();
    const scheduled = timerFor(ctx, 60_000);
    expect(scheduled, "a retry timer was armed").toBeTypeOf("function");
    ctx.i.setTimeout.mockClear();

    // The port is still busy — this attempt fails too.
    scheduled();
    await vi.waitFor(() => expect(ctx.i.setTimeout).toHaveBeenCalledWith(expect.any(Function), 60_000));

    expect(ctx.i.pending.map(p => p.name)).toEqual(["Kueche"]);
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
  });

  it("announces a device that joins an already running discovery", async () => {
    const ctx = setup(twoPlayers(), { failEcpPort: 8061 });
    await ctx.i.onReady();
    ctx.freeEcpPort();

    await ctx.i.retryPendingDevices();

    // Not by pushing into an array the responder happens to share — through its own door.
    expect(ctx.ssdps[0].addDevice).toHaveBeenCalledWith({ uuid: deriveUuid("Kueche"), port: 8061 });
    expect(ctx.i.states.get("info.connection")).toEqual({ val: true, ack: true });
  });

  it("the armed timer really runs the retry — not just the timer", async () => {
    // Wiring test: the queue is only worked off if the scheduled callback calls it. A
    // timer that fires into nothing leaves the device dead forever while every direct
    // test of retryPendingDevices stays green (the mutation run of 1.6.0 found this gap).
    const ctx = setup({ devices: [kueche()] }, { failEcpPort: 8061 });
    await ctx.i.onReady();
    const scheduled = timerFor(ctx, 60_000);
    expect(scheduled, "a retry timer was armed").toBeTypeOf("function");
    ctx.freeEcpPort();

    scheduled();
    await vi.waitFor(() => expect(ctx.i.running).toHaveLength(1));

    expect(ctx.i.pending).toHaveLength(0);
    expect(ctx.i.states.get("info.connection")).toEqual({ val: true, ack: true });
  });

  it("a status write that fails after a successful retry is caught instead of ending the instance", async () => {
    // The timer drops the retry with `void`. A rejection escaping it — the states database
    // refusing the status write — is an unhandled rejection, and js-controller ends the
    // instance over it (7.2.2 `_exceptionHandler`).
    const ctx = setup(twoPlayers(), { failEcpPort: 8061 });
    await ctx.i.onReady();
    ctx.freeEcpPort();
    ctx.i.setState.mockImplementationOnce(() => Promise.reject(new Error("states db gone")));

    await expect(ctx.i.retryPendingDevices()).resolves.toBeUndefined();

    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("states db gone"));
  });

  it("keeps quiet about a retry that fails again — one warning, not one a minute", async () => {
    const ctx = setup({ devices: [kueche()] }, { failEcpPort: 8061 });
    await ctx.i.onReady();
    ctx.i.log.warn.mockClear();

    await ctx.i.retryPendingDevices();

    expect(ctx.i.log.warn).not.toHaveBeenCalled();
    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("still cannot start"));
    expect(ctx.i.pending).toHaveLength(1);
  });

  it("does not queue a device whose server died at runtime", async () => {
    // A port busy at boot is a restart race and heals; a server that died while running
    // died for a reason this code does not know, and retrying it would flood the log.
    const ctx = setup();
    await ctx.i.onReady();
    const fatal = ctx.ecp[0].options.onFatalError as () => void;

    fatal();

    expect(ctx.i.pending).toHaveLength(0);
    expect(ctx.i.running).toHaveLength(0);
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
    // And discovery stops pointing remotes at a port nobody serves any more.
    expect(ctx.ssdps[0].removeDevice).toHaveBeenCalledWith(deriveUuid("Wohnzimmer"));
  });
});

describe("Fakeroku — the host says stop in the middle of the start", () => {
  it("starts nothing more and queues nothing once onUnload ran", async () => {
    const ctx = setup(
      {
        devices: [
          { name: "A", port: 8060, type: "player" },
          { name: "B", port: 8061, type: "player" },
        ],
      },
      { failEcpPort: 8060 },
    );
    // The host stops while the first device's objects are being created.
    stopWhenWriting(ctx, "A");
    await ctx.i.onReady();
    expect(ctx.ecp).toHaveLength(0);
    expect(ctx.i.pending).toHaveLength(0);
    // No "Only 0 of 2 … could be started" for a stop the user asked for.
    expect(ctx.i.log.error).not.toHaveBeenCalled();
  });
});

describe("Fakeroku — every stop point of the start", () => {
  it("stops after reading the object tree", async () => {
    const ctx = setup();
    const real = ctx.i.getAdapterObjectsAsync.getMockImplementation() as () => Promise<unknown>;
    ctx.i.getAdapterObjectsAsync.mockImplementationOnce(() => {
      ctx.i.onUnload(() => {});
      return real();
    });
    await ctx.i.onReady();
    expect(ctx.ecp).toHaveLength(0);
    expect(ctx.i.log.error).not.toHaveBeenCalled();
  });

  it("stops after the devices started, before the sweep", async () => {
    const ctx = setup();
    stopWhenWriting(ctx, "Wohnzimmer.keys.Home");
    await ctx.i.onReady();
    expect(ctx.ssdps).toHaveLength(0);
    expect(ctx.i.log.error).not.toHaveBeenCalled();
    // The orphan sweep reads the object tree a second time — it must not run once stopped.
    expect(ctx.i.getAdapterObjectsAsync).toHaveBeenCalledTimes(1);
  });

  it("stops after the sweep, before discovery", async () => {
    const ctx = setup();
    const real = ctx.i.getAdapterObjectsAsync.getMockImplementation() as () => Promise<unknown>;
    ctx.i.getAdapterObjectsAsync
      .mockImplementationOnce(() => real())
      .mockImplementationOnce(() => {
        ctx.i.onUnload(() => {});
        return real();
      });
    await ctx.i.onReady();
    expect(ctx.ssdps).toHaveLength(0);
    // onUnload emptied the running list: going on would report "no device could be started".
    expect(ctx.i.log.error).not.toHaveBeenCalled();
  });

  it("starts with an instance object that does not exist", async () => {
    const ctx = setup();
    ctx.i.getForeignObjectAsync.mockResolvedValueOnce(undefined);
    await ctx.i.onReady();
    expect(ctx.ecp).toHaveLength(1);
  });
});

describe("Fakeroku — stop points that only one guard covers", () => {
  it("a stop during the object read writes no new identity into the configuration", async () => {
    const ctx = setup({ devices: [{ name: "Roku", port: 8060, type: "player" }] }, { fresh: true });
    const real = ctx.i.getAdapterObjectsAsync.getMockImplementation() as () => Promise<unknown>;
    ctx.i.getAdapterObjectsAsync.mockImplementationOnce(() => {
      ctx.i.onUnload(() => {});
      return real();
    });
    await ctx.i.onReady();
    expect(ctx.i.extendForeignObjectAsync).not.toHaveBeenCalled();
  });

  it("a stop between two devices builds no tree for the second one", async () => {
    const ctx = setup(
      {
        devices: [
          { name: "Wohnzimmer", port: 8060, type: "player", uuid: "legacy-a" },
          { name: "Kueche", port: 8061, type: "player", uuid: "legacy-b" },
        ],
      },
      { fresh: true },
    );
    stopWhenWriting(ctx, "Wohnzimmer.keys.Home");
    await ctx.i.onReady();
    expect(ctx.i.objects.has("Kueche")).toBe(false);
  });
});

describe("Fakeroku onUnload", () => {
  it("stops every server, clears every timer and always calls back", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "Home" }); // arms a pulse timer
    const pulse = ctx.i.setTimeout.mock.results.at(-1)!.value as unknown;
    ctx.i.applyCommand("Wohnzimmer", { type: "keydown", key: "Select" }); // arms a watchdog
    const watchdog = ctx.i.setTimeout.mock.results.at(-1)!.value as unknown;
    ctx.i.clearTimeout.mockClear();
    ctx.i.clearInterval.mockClear();

    const callback = vi.fn();
    await new Promise<void>(resolve => ctx.i.onUnload(() => (callback(), resolve())));

    expect(callback).toHaveBeenCalledTimes(1);
    expect(ctx.ssdps[0].stop).toHaveBeenCalledTimes(1);
    expect(ctx.ecp[0].stop).toHaveBeenCalledTimes(1);
    expect(ctx.i.clearInterval).toHaveBeenCalledTimes(1); // the NOTIFY repeat
    expect(ctx.i.clearTimeout).toHaveBeenCalledWith(pulse);
    expect(ctx.i.clearTimeout).toHaveBeenCalledWith(watchdog);
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
  });

  it("reports done only after the last write has landed", async () => {
    const ctx = setup();
    await ctx.i.onReady();

    // The write has to settle a turn LATER than the call, or this test would pass
    // with the callback fired first — a write that resolves synchronously proves
    // nothing about ordering.
    const order: string[] = [];
    const store = ctx.i.states;
    ctx.i.setState.mockImplementation(
      (id: string, state: { val?: unknown; ack?: boolean }) =>
        new Promise<void>(resolve =>
          globalThis.setTimeout(() => {
            order.push(`write:${id}`);
            store.set(id, { val: state?.val, ack: state?.ack === true });
            resolve();
          }, 0),
        ),
    );

    await new Promise<void>(resolve => ctx.i.onUnload(() => (order.push("callback"), resolve())));

    // Fire-and-forget plus an immediate callback loses the write: the process is
    // gone before it reaches the database, and the instance keeps showing
    // "connected" while the adapter is off.
    expect(order).toEqual(["write:info.connection", "callback"]);
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
  });

  it("still reports done when the last write is rejected", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.setState.mockImplementation(() => Promise.reject(new Error("database gone")));

    // A teardown that never calls back is killed by js-controller — a failing
    // write must not cost the callback. And the rejection has to be HANDLED:
    // an unhandled one turns an orderly stop into a crash, so the debug trace is
    // the proof that something caught it.
    const callback = vi.fn();
    await new Promise<void>(resolve => ctx.i.onUnload(() => (callback(), resolve())));
    expect(callback).toHaveBeenCalledTimes(1);
    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("Final connection write failed"));
  });

  it("still calls back when a teardown step throws", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.ecp[0].stop.mockImplementation(() => {
      throw new Error("socket already gone");
    });

    const callback = vi.fn();
    // A throwing teardown that skips the callback is a hard kill by js-controller.
    expect(() => ctx.i.onUnload(callback)).not.toThrow();
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe("Fakeroku — the farewell on shutdown", () => {
  it("says goodbye before the socket closes, so the remote drops the device", async () => {
    // Without it a controller keeps the emulated Roku for the announced max-age — an hour
    // of a device that answers nothing.
    const ctx = setup();
    await ctx.i.onReady();
    const order: string[] = [];
    ctx.ssdps[0].byebye.mockImplementation(() => {
      order.push("byebye");
      return Promise.resolve();
    });
    ctx.ssdps[0].stop.mockImplementation(() => void order.push("stop"));

    await new Promise<void>(resolve => ctx.i.onUnload(resolve));

    expect(order).toEqual(["byebye", "stop"]);
  });

  it("drops every per-device collection it built", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.applyCommand("Wohnzimmer", { type: "keypress", key: "Home" });

    await new Promise<void>(resolve => ctx.i.onUnload(resolve));

    expect(ctx.i.devices.size).toBe(0);
    expect(ctx.i.running).toHaveLength(0);
    expect(ctx.i.pending).toHaveLength(0);
  });
});

describe("Fakeroku — two instances in one process (compact mode)", () => {
  // The host may load several instances into ONE node process. Everything an instance owns
  // then has to live on the instance, not in the module: a socket, a server, a timer or a
  // map shared by accident would let one instance tear down the other's world. These tests
  // are what `common.compact: true` in the manifest rests on.

  it("keeps two running instances completely apart", async () => {
    const a = setup({ devices: [{ name: "Wohnzimmer", port: 8060, type: "player" }] });
    const b = setup({ devices: [{ name: "Kueche", port: 8061, type: "tv" }] });

    await a.i.onReady();
    await b.i.onReady();

    // Each instance built its own server, its own advert and its own object tree.
    expect(a.ecp).toHaveLength(1);
    expect(b.ecp).toHaveLength(1);
    expect((a.ecp[0].options.device as { port: number }).port).toBe(8060);
    expect((b.ecp[0].options.device as { port: number }).port).toBe(8061);
    expect([...a.i.objects.keys()].some(k => k.startsWith("Kueche"))).toBe(false);
    expect([...b.i.objects.keys()].some(k => k.startsWith("Wohnzimmer"))).toBe(false);
    // A TV carries more keys than a player — proof the two trees are really separate.
    expect(b.i.devices.get("Kueche")!.keys.size).toBeGreaterThan(a.i.devices.get("Wohnzimmer")!.keys.size);
  });

  it("unloading one instance leaves the other running", async () => {
    const a = setup({ devices: [{ name: "Wohnzimmer", port: 8060, type: "player" }] });
    const b = setup({ devices: [kueche()] });
    await a.i.onReady();
    await b.i.onReady();

    await new Promise<void>(resolve => a.i.onUnload(resolve));

    // The one that stopped let go of everything …
    expect(a.i.devices.size).toBe(0);
    expect(a.i.running).toHaveLength(0);
    expect(a.ecp[0].stop).toHaveBeenCalledTimes(1);
    expect(a.ssdps[0].stop).toHaveBeenCalledTimes(1);
    // … and the other one noticed nothing: in one shared process this is the whole game.
    expect(b.i.devices.size).toBe(1);
    expect(b.i.running).toHaveLength(1);
    expect(b.ecp[0].stop).not.toHaveBeenCalled();
    expect(b.ssdps[0].stop).not.toHaveBeenCalled();
    expect(b.i.states.get("info.connection")).toEqual({ val: true, ack: true });
  });

  it("hands back a clean process once both are gone", async () => {
    const a = setup();
    const b = setup({ devices: [kueche()] });
    await a.i.onReady();
    await b.i.onReady();

    await new Promise<void>(resolve => a.i.onUnload(resolve));
    await new Promise<void>(resolve => b.i.onUnload(resolve));

    for (const ctx of [a, b]) {
      expect(ctx.i.devices.size).toBe(0);
      expect(ctx.i.running).toHaveLength(0);
      expect(ctx.i.pending).toHaveLength(0);
      expect(ctx.i.commands.pulseTimers.size).toBe(0);
      expect(ctx.i.commands.holdTimers.size).toBe(0);
    }
  });

  it("gives a held key of one instance no reach into the other", async () => {
    // The hold watchdog is a timer keyed by object id. Two instances run the same ids —
    // if that map were shared, one instance's keypress would disarm the other's watchdog.
    const a = setup();
    const b = setup();
    await a.i.onReady();
    await b.i.onReady();

    a.i.applyCommand("Wohnzimmer", { type: "keydown", key: "Home" });

    expect(a.i.commands.holdTimers.size).toBe(1);
    expect(b.i.commands.holdTimers.size).toBe(0);
    // Same object id in both instances — held down in one, at rest in the other.
    expect(a.i.states.get("Wohnzimmer.keys.Home")).toEqual({ val: true, ack: true });
    expect(b.i.states.get("Wohnzimmer.keys.Home")).toEqual({ val: false, ack: true });
  });
});

describe("Fakeroku — the compact-mode entry", () => {
  it("exports a factory that builds an instance instead of starting one", () => {
    // What js-controller does in compact mode: require the main file and call what it exports.
    // A text check of the source cannot tell an export that works from one that does not.
    const mod = mainModule as unknown as { default: (options: unknown) => unknown };
    expect(typeof mod.default).toBe("function");
    expect(mod.default({})).toBeInstanceOf(Fakeroku);
  });
});

describe("Fakeroku — the paths that only a failing database reaches", () => {
  it("skips a device whose objects cannot be created and keeps the others", async () => {
    const ctx = setup(twoPlayers());
    const realExtend = ctx.i.extendObject.getMockImplementation() as (
      id: string,
      obj: Record<string, unknown>,
    ) => Promise<void>;
    ctx.i.extendObject.mockImplementation((id: string, obj: Record<string, unknown>) =>
      id.startsWith("Wohnzimmer") ? Promise.reject(new Error("objects database is closed")) : realExtend(id, obj),
    );

    await ctx.i.onReady();

    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("could not be created"));
    // The other device still comes up — one broken tree must not take the instance down.
    expect(ctx.ecp).toHaveLength(1);
    expect((ctx.ecp[0].options.device as { port: number }).port).toBe(8061);
  });

  it("traces a rewrite it cannot perform instead of failing the start", async () => {
    const ctx = setup();
    ctx.i.objects.set("Wohnzimmer.keys.Home", { type: "state", common: {}, native: { url: "keys/Home" } });
    ctx.i.setForeignObject.mockImplementation(() => Promise.reject(new Error("read-only")));

    await ctx.i.onReady();

    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("could not rewrite"));
    // The object survives the failed repair with its leftover — worse would be losing it.
    expect(ctx.i.objects.get("Wohnzimmer.keys.Home")?.native).toEqual({ url: "keys/Home" });
    expect(ctx.i.states.get("info.connection")).toEqual({ val: true, ack: true });
  });

  it("a retry still binding when the host says stop registers nothing and writes nothing", async () => {
    // The minute retry can be sitting in `await server.start()` when onUnload runs. Without
    // the stopping flag the finished server lands in a map onUnload already emptied — nothing
    // would ever close it — the queue refills, scheduleDeviceRetry arms a timer js-controller
    // refuses during shutdown, and reportConnectionState writes info.connection TRUE after
    // the closing FALSE. That last one is exactly what waiting for the final write prevents.
    const ctx = setup({ devices: [kueche()] }, { failEcpPort: 8061 });
    await ctx.i.onReady();
    expect(ctx.i.pending).toHaveLength(1);

    // A bind that has not settled yet, the way a slow start looks from here.
    const { start, release } = deferredStart();
    let late = fakeEcp({}, start);
    ctx.i.makeEcpServer = (options: Record<string, unknown>): FakeEcp => (late = fakeEcp(options, start));
    const retry = ctx.i.retryPendingDevices();
    ctx.i.setTimeout.mockClear();

    ctx.i.onUnload(() => {});
    release();
    await retry;

    expect(late.stop).toHaveBeenCalledTimes(1);
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
    expect(ctx.i.pending).toHaveLength(0);
    expect(ctx.i.setTimeout).not.toHaveBeenCalled();
  });

  it("names the missing address instead of logging a gap when the retry finds none", async () => {
    // detectPrimaryIPv4 can come back empty on the retry path — the host lost its address
    // in the meantime. The line then read "advertising on  (discovery off)", which looks
    // like a truncated log line rather than the finding it is.
    const ctx = setup(
      { devices: [{ name: "Kueche", port: 8061, type: "player" }], bind: "" },
      {
        failEcpPort: 8061,
      },
    );
    osMock.interfaces = { eth0: [{ family: "IPv4", address: "192.168.1.5", internal: false }] };
    await ctx.i.onReady();
    // The address is gone by the time the retry runs.
    noAddressYet();
    ctx.freeEcpPort();

    await ctx.i.retryPendingDevices();

    expect(ctx.i.log.info).toHaveBeenCalledWith(expect.stringContaining("advertising on no routable IPv4"));
  });

  it("a retry that fires after unload does nothing at all", async () => {
    // The timer callback can already be queued when the host says stop — onUnload clears
    // the handle, not a call that is already on its way. It must find an empty queue and
    // leave without building a server into the map onUnload just emptied, and without
    // reporting the instance green again after the shutdown wrote false.
    const ctx = setup({ devices: [kueche()] }, { failEcpPort: 8061 });
    await ctx.i.onReady();
    ctx.i.onUnload(() => {});
    const built = ctx.ecp.length;
    ctx.freeEcpPort();

    await ctx.i.retryPendingDevices();

    expect(ctx.ecp).toHaveLength(built);
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
  });

  /**
   * A discovery whose bind resolves only when the test says so — startDiscovery does not await it.
   *
   * @param ctx the test context
   * @returns the fake responder and the trigger that lets its bind land
   */
  function lateSsdp(ctx: Ctx): { late: () => FakeSsdp; release: () => void } {
    const { start, release } = deferredStart();
    let late = fakeSsdp({}, start);
    ctx.i.makeSsdpResponder = (options: Record<string, unknown>): FakeSsdp => (late = fakeSsdp(options, start));
    return { late: () => late, release };
  }

  it("a discovery bind that lands after unload neither announces nor arms an interval", async () => {
    // If the bind resolves after the farewell went out, announcing would put the devices back
    // into a network we just left, and this.setInterval would refuse the repeat timer with
    // "setInterval called, but adapter is shutting down" — a warning nothing explains.
    const ctx = setup();
    const { late, release } = lateSsdp(ctx);
    await ctx.i.onReady();
    ctx.i.setInterval.mockClear();

    ctx.i.onUnload(() => {});
    release();
    await settle();

    expect(late().announce).not.toHaveBeenCalled();
    expect(ctx.i.setInterval).not.toHaveBeenCalled();
  });

  it("the same late bind without an unload announces after one settle — the wait above is long enough", async () => {
    const ctx = setup();
    const { late, release } = lateSsdp(ctx);
    await ctx.i.onReady();
    release();
    await settle();
    expect(late().announce).toHaveBeenCalled();
  });

  it("disarms the retry timer on unload", async () => {
    const ctx = setup({ devices: [kueche()] }, { failEcpPort: 8061 });
    await ctx.i.onReady();
    const at = ctx.i.setTimeout.mock.calls.findIndex(([, ms]) => ms === 60_000);
    const retryHandle = ctx.i.setTimeout.mock.results[at].value as unknown;
    ctx.i.clearTimeout.mockClear();

    await new Promise<void>(resolve => ctx.i.onUnload(resolve));

    // A timer left armed keeps firing into an adapter that is already gone — and it is THIS
    // handle, not any timer, that has to be cleared.
    expect(ctx.i.clearTimeout).toHaveBeenCalledWith(retryHandle);
  });
});
