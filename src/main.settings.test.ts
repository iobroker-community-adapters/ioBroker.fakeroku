import { vi } from "vitest";
import type * as OsModule from "node:os";

/**
 * Orchestration tests of the adapter — The one-shot repair of the instance object: legacy keys move or drop in one write, one restart.
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

import { setup, type internalOf, resetHarness } from "../test/helpers/fakeroku-harness";
import { osMock } from "../test/helpers/os-double";

afterEach(resetHarness);

describe("Fakeroku — the instance object is repaired once", () => {
  it("moves a pre-0.5.0 BIND address onto bind and restarts instead of starting", async () => {
    const ctx = setup({ bind: "0.0.0.0", BIND: "10.1.2.3" });
    await ctx.i.onReady();
    // The write to the own instance object restarts the instance — binding a port in a process
    // about to go down would leave the port held by a dying process.
    expect(ctx.ecp).toHaveLength(0);
    expect(ctx.i.instanceNative.bind).toBe("10.1.2.3");
    // Nulled, not deleted: a merge cannot remove a key, and null is what makes it falsy.
    expect(ctx.i.instanceNative.BIND).toBeNull();
    expect(ctx.i.log.info).toHaveBeenCalledWith(expect.stringContaining("restarts once"));
  });

  it("moves the old networkInterface key onto bind", async () => {
    const ctx = setup({ bind: "0.0.0.0", networkInterface: "192.168.1.9" });
    await ctx.i.onReady();
    expect(ctx.ecp).toHaveLength(0);
    expect(ctx.i.instanceNative.bind).toBe("192.168.1.9");
    expect(ctx.i.instanceNative.networkInterface).toBeNull();
  });

  it("the setting the user saw last wins: networkInterface beats an older BIND, which is only cleared", async () => {
    // networkInterface exists only on an instance that ran 0.6.0–1.6.1 — its admin showed that
    // key, "" meant all interfaces. The old adapter's BIND next to it is a leftover from years ago.
    for (const iface of ["", "0.0.0.0"]) {
      const ctx = setup({ bind: "0.0.0.0", networkInterface: iface, BIND: "10.1.2.3" });
      await ctx.i.onReady();
      expect(ctx.i.instanceNative.bind, iface).toBe("0.0.0.0");
      expect(ctx.i.instanceNative.networkInterface, iface).toBeNull();
      expect(ctx.i.instanceNative.BIND, iface).toBeNull();
    }
    const concrete = setup({ bind: "0.0.0.0", networkInterface: "192.168.1.9", BIND: "10.1.2.3" });
    await concrete.i.onReady();
    expect(concrete.i.instanceNative.bind).toBe("192.168.1.9");
    expect(concrete.i.instanceNative.BIND).toBeNull();
  });

  it("drops the keys the 0.1.x adapter declared and nothing reads any more, then restarts once", async () => {
    const ctx = setup({ HTTP_PORT: 8060, MULTICAST_IP: "239.255.255.250", UUID: "0a1b2c" });
    await ctx.i.onReady();
    // js-controller never deletes a native key: without the drop they stay in the instance for good.
    expect(ctx.i.instanceNative.HTTP_PORT).toBeNull();
    expect(ctx.i.instanceNative.MULTICAST_IP).toBeNull();
    expect(ctx.i.instanceNative.UUID).toBeNull();
    expect(ctx.ecp).toHaveLength(0);
    expect(ctx.i.log.info).toHaveBeenCalledWith(expect.stringContaining("Obsolete settings removed"));
  });

  it("an empty legacy address migrates to 0.0.0.0, never to an empty string", async () => {
    const ctx = setup({ bind: "0.0.0.0", networkInterface: "" });
    await ctx.i.onReady();
    // The admin's port-conflict check skips an instance whose bind is falsy, so a migrated ""
    // would leave the adapter exactly as invisible as the old key did.
    expect(ctx.i.instanceNative.bind).toBe("0.0.0.0");
    expect(ctx.i.instanceNative.networkInterface).toBeNull();
  });

  it("drops the leftover common keys, so a second instance becomes possible at all", async () => {
    const ctx = setup({ bind: "10.1.2.3" });
    ctx.i.instanceNative.networkInterface = null;
    ctx.i.instanceNative.BIND = null;
    // singletonHost left the manifest in 1.6.0 and license was replaced by licenseInformation, but
    // js-controller never deletes a common key it wrote — every older installation still has both.
    ctx.i.instanceCommon.singletonHost = true;
    ctx.i.instanceCommon.license = "MIT";
    await ctx.i.onReady();
    expect(ctx.ecp).toHaveLength(0);
    expect(ctx.i.instanceCommon.singletonHost).toBeNull();
    expect(ctx.i.instanceCommon.license).toBeNull();
    expect(ctx.i.log.info).toHaveBeenCalledWith(expect.stringContaining("common.singletonHost"));
  });

  it("repairs the settings and the common keys in ONE write — one restart, then never again", async () => {
    const ctx = setup({ bind: "0.0.0.0", networkInterface: "192.168.1.9" });
    ctx.i.instanceCommon.singletonHost = true;
    await ctx.i.onReady();
    expect(ctx.ecp).toHaveLength(0);
    expect(ctx.i.instanceNative.bind).toBe("192.168.1.9");
    expect(ctx.i.instanceCommon.singletonHost).toBeNull();
    expect(ctx.i.extendForeignObjectAsync).toHaveBeenCalledTimes(1);
  });

  it("starts anyway when the instance object cannot be read", async () => {
    const ctx = setup({ bind: "192.168.1.5" });
    ctx.i.getForeignObjectAsync.mockRejectedValueOnce(new Error("objects db busy"));
    await ctx.i.onReady();
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("objects db busy"));
    expect(ctx.ecp).toHaveLength(1);
  });

  it("a failed settings write starts this run with the MIGRATED address, not the injected default", async () => {
    const ctx = setup({ bind: "0.0.0.0", networkInterface: "192.168.1.5" });
    ctx.i.extendForeignObjectAsync.mockRejectedValueOnce(new Error("write refused"));
    await ctx.i.onReady();
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("write refused"));
    expect(ctx.i.config.bind).toBe("192.168.1.5");
    expect(ctx.ecp[0].options.bindIp).toBe("192.168.1.5");
  });

  it("a failed host-claim write starts anyway and tries again next time", async () => {
    const ctx = setup({ bind: "192.168.1.5" });
    ctx.i.instanceCommon.singletonHost = true;
    ctx.i.extendForeignObjectAsync.mockRejectedValueOnce(new Error("write refused"));
    await ctx.i.onReady();
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("ignoring common.singletonHost"));
    expect(ctx.ecp).toHaveLength(1);
  });

  it.each([
    ["a repaired host claim", (i: ReturnType<typeof internalOf>): void => void (i.instanceCommon.singletonHost = null)],
    ["legacy keys already null", (i: ReturnType<typeof internalOf>): void => void (i.instanceNative.BIND = null)],
  ])("does not migrate again with %s — the restart happens ONCE", async (_case, nulled) => {
    osMock.interfaces = { eth0: [{ family: "IPv4", address: "10.1.2.3", internal: false, cidr: "10.1.2.3/24" }] };
    const ctx = setup({ bind: "10.1.2.3" });
    ctx.i.instanceNative.networkInterface = null;
    nulled(ctx.i);
    await ctx.i.onReady();
    // A helper that asked hasOwnProperty would migrate on every start and restart for ever.
    expect(ctx.i.extendForeignObjectAsync).not.toHaveBeenCalled();
    expect(ctx.ecp[0].options.bindIp).toBe("10.1.2.3");
  });

  it("a networkInterface key emptied to null does not beat the old adapter's BIND", async () => {
    const ctx = setup({ bind: "0.0.0.0", networkInterface: null, BIND: "10.1.2.3" });
    await ctx.i.onReady();
    expect(ctx.i.instanceNative.bind).toBe("10.1.2.3");
  });
});
