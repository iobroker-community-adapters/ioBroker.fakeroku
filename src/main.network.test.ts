import { vi } from "vitest";
import type * as OsModule from "node:os";

/**
 * Orchestration tests of the adapter — The network side: interfaces, the trust boundary, discovery as an aid and a chosen address the host does not carry.
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

import { setup, resetHarness, noAddressYet } from "../test/helpers/fakeroku-harness";
import { osMock } from "../test/helpers/os-double";

afterEach(resetHarness);

describe("Fakeroku onReady — network interface", () => {
  it("a configured interface pins both the bind and the announcement", async () => {
    const ctx = setup({ bind: "192.168.1.5" });
    await ctx.i.onReady();
    expect(ctx.ecp[0].options.bindIp).toBe("192.168.1.5");
    expect(ctx.ssdps[0].options).toMatchObject({
      bindIp: "192.168.1.5",
      advertiseIp: "192.168.1.5",
      membershipInterfaces: [{ iface: "eth0", address: "192.168.1.5" }],
    });
  });

  it('auto ("" or 0.0.0.0) binds everything and joins every routable interface', async () => {
    osMock.interfaces = {
      lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
      eth0: [{ family: "IPv4", address: "192.168.1.20", internal: false }],
      wlan0: [{ family: "IPv4", address: "10.0.0.7", internal: false }],
    };
    for (const value of ["", "0.0.0.0"]) {
      const ctx = setup({ bind: value });
      await ctx.i.onReady();
      expect(ctx.ecp[0].options.bindIp, value).toBeUndefined();
      expect(ctx.ssdps[0].options.advertiseIp, value).toBe("192.168.1.20");
      // Multi-homed: joining only one interface makes the emulator invisible on
      // the other LAN.
      expect(ctx.ssdps[0].options.membershipInterfaces, value).toEqual([
        { iface: "eth0", address: "192.168.1.20" },
        { iface: "wlan0", address: "10.0.0.7" },
      ]);
    }
  });

  it("all interfaces without any IPv4: the Rokus listen, discovery is unavailable like any failed start", async () => {
    // No special path that waits for an address: the ECP servers bind every interface and need none, discovery has
    // nothing to announce and says so.
    noAddressYet();
    const ctx = setup({ bind: "" });
    await ctx.i.onReady();
    expect(ctx.ecp).toHaveLength(1);
    expect(ctx.ecp[0].options.bindIp).toBeUndefined();
    expect(ctx.ssdps).toHaveLength(0);
    expect(ctx.i.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("SSDP discovery unavailable: the host has no IPv4"),
    );
  });

  it("a chosen address the host does not carry: listens on all addresses, says so once, not healthy", async () => {
    // A new address from the router, a restored backup on other hardware: the remotes still find the Roku, and the
    // log names what to fix.
    osMock.interfaces = { eth0: [{ family: "IPv4", address: "10.0.0.9", internal: false, cidr: "10.0.0.9/24" }] };
    const ctx = setup({ bind: "192.168.1.5" });
    await ctx.i.onReady();
    expect(ctx.ecp).toHaveLength(1);
    expect(ctx.ecp[0].options.bindIp).toBeUndefined();
    expect(ctx.ssdps[0].options).toMatchObject({
      bindIp: undefined,
      membershipInterfaces: [{ iface: "eth0", address: "10.0.0.9" }],
    });
    const missing = ctx.i.log.warn.mock.calls.filter(([text]) =>
      String(text).includes("Address 192.168.1.5 does not exist on this host — listening on all addresses"),
    );
    expect(missing).toHaveLength(1);
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
    // The setting stays the user's — nothing rewrites it.
    expect(ctx.i.instanceNative.bind).toBe("192.168.1.5");
    // No search for the address any more.
    expect(ctx.i.setTimeout).not.toHaveBeenCalledWith(expect.any(Function), 10_000);
  });

  it("with the chosen address missing, every own network counts — the trust boundary follows the fallback", async () => {
    osMock.interfaces = { eth0: [{ family: "IPv4", address: "10.0.0.9", internal: false, cidr: "10.0.0.9/24" }] };
    const ctx = setup({ bind: "192.168.1.5" });
    await ctx.i.onReady();
    const allowed = ctx.ecp[0].options.isClientAllowed as (a: string) => boolean;
    expect(allowed("10.0.0.77")).toBe(true);
    expect(allowed("192.168.1.77")).toBe(false);
  });

  it("ECP and discovery answer only the chosen interface's network", async () => {
    osMock.interfaces = {
      eth0: [{ family: "IPv4", address: "192.168.1.5", internal: false, cidr: "192.168.1.5/24" }],
      "eth0.50": [{ family: "IPv4", address: "192.168.50.2", internal: false, cidr: "192.168.50.2/24" }],
    };
    const ctx = setup({ bind: "192.168.1.5" });
    await ctx.i.onReady();
    const ecpAllowed = ctx.ecp[0].options.isClientAllowed as (a: string) => boolean;
    const ssdpAllowed = ctx.ssdps[0].options.isClientAllowed as (a: string) => boolean;
    for (const allowed of [ecpAllowed, ssdpAllowed]) {
      expect(allowed("192.168.1.77")).toBe(true);
      expect(allowed("192.168.50.77")).toBe(false);
    }
    expect(ctx.ssdps[0].options.advertiseFor).toBeUndefined();
  });

  it("all interfaces answer every own network, each with the host's address in it", async () => {
    osMock.interfaces = {
      eth0: [{ family: "IPv4", address: "192.168.1.5", internal: false, cidr: "192.168.1.5/24" }],
      "eth0.50": [{ family: "IPv4", address: "192.168.50.2", internal: false, cidr: "192.168.50.2/24" }],
    };
    const ctx = setup({ bind: "0.0.0.0" });
    await ctx.i.onReady();
    const allowed = ctx.ssdps[0].options.isClientAllowed as (a: string) => boolean;
    expect(allowed("192.168.50.77")).toBe(true);
    expect(allowed("10.9.9.9")).toBe(false);
    const advertiseFor = ctx.ssdps[0].options.advertiseFor as (a: string) => string | undefined;
    expect(advertiseFor("192.168.50.77")).toBe("192.168.50.2");
    expect(advertiseFor("192.168.1.77")).toBe("192.168.1.5");
  });
});

describe("Fakeroku onReady — discovery is an aid, not a precondition", () => {
  it("a failing SSDP start leaves the adapter usable and announces nothing", async () => {
    const ctx = setup({}, { ssdpStartFails: true });
    await ctx.i.onReady();

    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("SSDP discovery unavailable"));
    // ECP is what makes the adapter controllable — already-paired remotes work.
    expect(ctx.i.states.get("info.connection")).toEqual({ val: true, ack: true });
    expect(ctx.ssdps[0].announce).not.toHaveBeenCalled();
    expect(ctx.i.ssdp).toBeUndefined();
  });

  it("closes a responder whose start failed, so a late bind cannot outlive the dropped reference", async () => {
    const ctx = setup({}, { ssdpStartFails: true });
    await ctx.i.onReady();
    // A bind that only timed out can still complete later; without stop() that
    // socket keeps answering searches and onUnload has no handle left to close it.
    expect(ctx.ssdps[0].stop).toHaveBeenCalledTimes(1);
  });

  it("a successful start announces immediately and arms the repeat", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    expect(ctx.ssdps[0].announce).toHaveBeenCalledTimes(1);
    const repeat = ctx.i.setInterval.mock.calls.at(-1);
    expect(repeat, "the NOTIFY repeat must be armed").toBeDefined();
    // Fire the interval the way the runtime would — it must announce again.
    (repeat![0] as () => void)();
    expect(ctx.ssdps[0].announce).toHaveBeenCalledTimes(2);
  });

  it("follows a changed host address on the NOTIFY tick instead of announcing a dead one", async () => {
    // The advertised IP is baked into every LOCATION header and a remote caches it for the
    // announced max-age of an hour. Frozen at the value found during onReady, a DHCP lease
    // change left discovery pointing at an address nobody serves — in front of an instance
    // that still reported itself connected.
    osMock.interfaces = { eth0: [{ family: "IPv4", address: "192.168.1.5", internal: false }] };
    const ctx = setup({ bind: "" });
    await ctx.i.onReady();
    expect(ctx.ssdps[0].options.advertiseIp).toBe("192.168.1.5");
    const tick = ctx.i.setInterval.mock.calls.at(-1)![0] as () => void;

    osMock.interfaces = { eth0: [{ family: "IPv4", address: "192.168.1.77", internal: false }] };
    tick();

    expect(ctx.ssdps[0].refreshAdvertise).toHaveBeenCalledWith("192.168.1.77", [
      { iface: "eth0", address: "192.168.1.77" },
    ]);
    expect(ctx.i.log.info).toHaveBeenCalledWith(expect.stringContaining("now advertised on 192.168.1.77"));
    // And the corrected address goes out with this very pass, not the next one.
    expect(ctx.ssdps[0].announce).toHaveBeenCalled();
  });

  it("says nothing while the address stays put — the tick must not become log noise", async () => {
    // Every five minutes, for the lifetime of the instance. A line per pass would bury
    // everything else in the log of a host whose address never moves.
    osMock.interfaces = { eth0: [{ family: "IPv4", address: "192.168.1.5", internal: false }] };
    const ctx = setup({ bind: "" });
    await ctx.i.onReady();
    const tick = ctx.i.setInterval.mock.calls.at(-1)![0] as () => void;
    ctx.i.log.info.mockClear();

    tick();
    tick();

    expect(ctx.i.log.info).not.toHaveBeenCalled();
    expect(ctx.ssdps[0].announce).toHaveBeenCalledTimes(3); // the start plus both ticks
  });

  it("never overrides a network interface the user chose", async () => {
    // A configured interface is a decision, not a guess: following the host's current
    // address would silently undo it the first time the machine got a second address.
    osMock.interfaces = {
      eth0: [{ family: "IPv4", address: "10.0.0.9", internal: false }],
      eth1: [{ family: "IPv4", address: "192.168.1.5", internal: false }],
    };
    const ctx = setup({ bind: "192.168.1.5" });
    await ctx.i.onReady();
    const tick = ctx.i.setInterval.mock.calls.at(-1)![0] as () => void;

    tick();

    expect(ctx.ssdps[0].refreshAdvertise).not.toHaveBeenCalled();
    expect(ctx.ssdps[0].options.advertiseIp).toBe("192.168.1.5");
  });

  it("a runtime socket death stops announcing but keeps ECP alive", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.clearInterval.mockClear();

    ctx.i.onSsdpFatal();

    expect(ctx.i.clearInterval).toHaveBeenCalledTimes(1);
    expect(ctx.i.ssdp).toBeUndefined();
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("SSDP discovery stopped"));
    // info.connection reflects ECP readiness and must NOT drop here.
    expect(ctx.i.states.get("info.connection")).toEqual({ val: true, ack: true });
  });
});

describe("Fakeroku — network interface rules without a single-interface shortcut", () => {
  it("a chosen interface joins only that interface, not every one the host has", async () => {
    osMock.interfaces = {
      eth0: [{ family: "IPv4", address: "192.168.1.5", internal: false, cidr: "192.168.1.5/24" }],
      wlan0: [{ family: "IPv4", address: "10.0.0.7", internal: false, cidr: "10.0.0.7/24" }],
    };
    const ctx = setup({ bind: "192.168.1.5" });
    await ctx.i.onReady();
    expect(ctx.ssdps[0].options.membershipInterfaces).toEqual([{ iface: "eth0", address: "192.168.1.5" }]);
  });
});
