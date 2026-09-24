import { buildNativeKeyPatch, migrateNativeKeys, type NativeKeyMigration } from "./native-key-migration";

type Log = (msg: string) => void;
type Read = (id: string) => Promise<unknown>;
type Merge = (id: string, obj: { native: Record<string, unknown> }) => Promise<unknown>;

interface FakeAdapter {
  namespace: string;
  log: { info: ReturnType<typeof vi.fn<Log>>; warn: ReturnType<typeof vi.fn<Log>> };
  config: Record<string, unknown>;
  getForeignObjectAsync: ReturnType<typeof vi.fn<Read>>;
  extendForeignObjectAsync: ReturnType<typeof vi.fn<Merge>>;
}

/**
 * A fake adapter whose object store applies every merge, so a second run sees the first.
 *
 * @param native the instance's native settings (undefined = no instance object)
 * @param opts failure switches for the read and the write
 * @param opts.readFails reject the object read
 * @param opts.writeFails reject the merge
 */
function fakeAdapter(
  native: Record<string, unknown> | undefined,
  opts: { readFails?: boolean; writeFails?: boolean } = {},
): { adapter: FakeAdapter; store: { native?: Record<string, unknown> } | null } {
  const store: { native?: Record<string, unknown> } | null = native ? { native: { ...native } } : null;
  const adapter: FakeAdapter = {
    namespace: "adapter.0",
    log: { info: vi.fn<Log>(), warn: vi.fn<Log>() },
    config: { ...(native ?? {}) },
    getForeignObjectAsync: vi.fn<Read>((): Promise<unknown> => {
      if (opts.readFails) {
        return Promise.reject(new Error("objects db unreachable"));
      }
      // A copy, as the controller answers — only a write reaches the store.
      return Promise.resolve(structuredClone(store));
    }),
    extendForeignObjectAsync: vi.fn<Merge>(
      (_id: string, obj: { native: Record<string, unknown> }): Promise<unknown> => {
        if (opts.writeFails) {
          return Promise.reject(new Error("write refused"));
        }
        if (store) {
          Object.assign(store.native!, obj.native);
        }
        return Promise.resolve({});
      },
    ),
  };
  return { adapter, store };
}

/**
 * The caller's error-text helper, as the adapter passes it in (the fleet form: one per repository).
 * Marked, so a test can prove the migration renders through it and not on its own.
 *
 * @param e the caught value
 * @returns the rendered text
 */
function errText(e: unknown): string {
  return `[via helper] ${e instanceof Error ? e.message : String(e)}`;
}

const HOST_TO_BIND: NativeKeyMigration[] = [
  { from: "host", to: "bind", coerce: v => (typeof v === "string" && v.trim()) || "0.0.0.0" },
  { key: "port", coerce: v => (typeof v === "string" ? Number.parseInt(v, 10) : v) },
];

const IFACE_AND_BIND: NativeKeyMigration[] = [
  { from: "networkInterface", to: "bind" },
  { from: "BIND", to: "bind" },
];

describe("buildNativeKeyPatch", () => {
  it("moves the old value to the new key and nulls the old key", () => {
    expect(buildNativeKeyPatch({ host: "192.168.1.10", bind: "0.0.0.0", port: 8080 }, HOST_TO_BIND)).toEqual({
      bind: "192.168.1.10",
      host: null,
    });
  });

  it("writes nothing when the old key is absent or already nulled", () => {
    expect(buildNativeKeyPatch({ bind: "10.0.0.5", port: 8080 }, HOST_TO_BIND)).toEqual({});
    expect(buildNativeKeyPatch({ host: null, bind: "10.0.0.5", port: 8080 }, HOST_TO_BIND)).toEqual({});
  });

  it("lets the old value win over a freshly added default on the new key", () => {
    // After the update js-controller added `bind` with the manifest default — the user's
    // address still lives under `host`.
    expect(buildNativeKeyPatch({ host: "192.168.1.10", bind: "0.0.0.0" }, HOST_TO_BIND)).toEqual({
      bind: "192.168.1.10",
      host: null,
    });
  });

  it("runs the rename coercion — an empty legacy host becomes listen-everywhere", () => {
    expect(buildNativeKeyPatch({ host: "  " }, HOST_TO_BIND)).toEqual({ bind: "0.0.0.0", host: null });
  });

  it("coerces a value in place only when it changes", () => {
    expect(buildNativeKeyPatch({ port: "8080" }, HOST_TO_BIND)).toEqual({ port: 8080 });
    expect(buildNativeKeyPatch({ port: 8080 }, HOST_TO_BIND)).toEqual({});
    expect(buildNativeKeyPatch({}, HOST_TO_BIND)).toEqual({});
  });

  it("does not store a coercion that yields NaN or undefined", () => {
    expect(buildNativeKeyPatch({ port: "abc" }, HOST_TO_BIND)).toEqual({});
    expect(buildNativeKeyPatch({ host: "x" }, [{ from: "host", to: "bind", coerce: () => undefined }])).toEqual({});
  });

  it("prefers the meaningful source when several old keys compete for one new key", () => {
    // The upgrade injected the default into `networkInterface`; the concrete address the
    // user entered years ago still sits under `BIND` — it must not lose to the default.
    expect(buildNativeKeyPatch({ networkInterface: "0.0.0.0", BIND: "10.47.88.2" }, IFACE_AND_BIND)).toEqual({
      bind: "10.47.88.2",
      networkInterface: null,
      BIND: null,
    });
    expect(buildNativeKeyPatch({ networkInterface: "", BIND: "10.47.88.2" }, IFACE_AND_BIND)).toEqual({
      bind: "10.47.88.2",
      networkInterface: null,
      BIND: null,
    });
  });

  it("takes the first source in order when both are meaningful", () => {
    expect(buildNativeKeyPatch({ networkInterface: "10.0.0.5", BIND: "10.0.0.9" }, IFACE_AND_BIND)).toEqual({
      bind: "10.0.0.5",
      networkInterface: null,
      BIND: null,
    });
  });

  it("falls back to the first present source when none is meaningful, and nulls only present sources", () => {
    expect(buildNativeKeyPatch({ networkInterface: "0.0.0.0" }, IFACE_AND_BIND)).toEqual({
      bind: "0.0.0.0",
      networkInterface: null,
    });
    // Moved verbatim — turning "" into "0.0.0.0" is the caller's coerce (see HOST_TO_BIND):
    // the admin skips an instance whose bind is empty, so a rename onto `bind` must supply it.
    expect(buildNativeKeyPatch({ BIND: "" }, IFACE_AND_BIND)).toEqual({ bind: "", BIND: null });
  });
});

describe("migrateNativeKeys", () => {
  it("merges only the touched keys in one write and reports the restart", async () => {
    const { adapter, store } = fakeAdapter({ host: "192.168.1.10", bind: "0.0.0.0", port: "8080", udn: "u" });
    await expect(migrateNativeKeys(adapter, HOST_TO_BIND, errText)).resolves.toBe(true);
    expect(adapter.extendForeignObjectAsync).toHaveBeenCalledTimes(1);
    expect(adapter.extendForeignObjectAsync).toHaveBeenCalledWith("system.adapter.adapter.0", {
      native: { bind: "192.168.1.10", host: null, port: 8080 },
    });
    expect(store?.native).toEqual({ host: null, bind: "192.168.1.10", port: 8080, udn: "u" });
    expect(adapter.log.info).toHaveBeenCalledTimes(1);
    expect(adapter.log.info.mock.calls[0][0]).toContain('bind = "192.168.1.10", port = 8080');
    expect(adapter.log.info.mock.calls[0][0]).toContain("restarts once");
    expect(adapter.log.warn).not.toHaveBeenCalled();
  });

  it("is idempotent — the second start writes nothing", async () => {
    const { adapter } = fakeAdapter({ host: "192.168.1.10", bind: "0.0.0.0", port: "8080" });
    await expect(migrateNativeKeys(adapter, HOST_TO_BIND, errText)).resolves.toBe(true);
    await expect(migrateNativeKeys(adapter, HOST_TO_BIND, errText)).resolves.toBe(false);
    expect(adapter.extendForeignObjectAsync).toHaveBeenCalledTimes(1);
    expect(adapter.log.info).toHaveBeenCalledTimes(1);
  });

  it("writes nothing on an installation that already uses the standard keys", async () => {
    const { adapter } = fakeAdapter({ bind: "0.0.0.0", port: 8080 });
    await expect(migrateNativeKeys(adapter, HOST_TO_BIND, errText)).resolves.toBe(false);
    expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
    expect(adapter.log.info).not.toHaveBeenCalled();
  });

  it("writes nothing when the instance object has no native part", async () => {
    const { adapter } = fakeAdapter(undefined);
    await expect(migrateNativeKeys(adapter, HOST_TO_BIND, errText)).resolves.toBe(false);
    expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
  });

  it("warns and continues when the instance object cannot be read", async () => {
    const { adapter } = fakeAdapter({ host: "192.168.1.10" }, { readFails: true });
    await expect(migrateNativeKeys(adapter, HOST_TO_BIND, errText)).resolves.toBe(false);
    expect(adapter.extendForeignObjectAsync).not.toHaveBeenCalled();
    expect(adapter.log.warn).toHaveBeenCalledTimes(1);
    expect(adapter.log.warn.mock.calls[0][0]).toContain("objects db unreachable");
  });

  it("renders both failures through the caller's helper, never on its own", async () => {
    const read = fakeAdapter({ host: "192.168.1.10" }, { readFails: true });
    await expect(migrateNativeKeys(read.adapter, HOST_TO_BIND, errText)).resolves.toBe(false);
    expect(read.adapter.log.warn.mock.calls[0][0]).toContain("[via helper] objects db unreachable");
    const write = fakeAdapter({ host: "192.168.1.10", bind: "0.0.0.0", port: "8080" }, { writeFails: true });
    await expect(migrateNativeKeys(write.adapter, HOST_TO_BIND, errText)).resolves.toBe(false);
    expect(write.adapter.log.warn.mock.calls[0][0]).toContain("[via helper] write refused");
  });

  it("patches the in-memory config and continues when the write fails", async () => {
    const { adapter } = fakeAdapter({ host: "192.168.1.10", bind: "0.0.0.0", port: "8080" }, { writeFails: true });
    await expect(migrateNativeKeys(adapter, HOST_TO_BIND, errText)).resolves.toBe(false);
    expect(adapter.log.warn).toHaveBeenCalledTimes(1);
    expect(adapter.log.warn.mock.calls[0][0]).toContain("write refused");
    expect(adapter.log.info).not.toHaveBeenCalled();
    // The start goes on with the migrated values; the old key is gone from memory.
    expect(adapter.config).toEqual({ bind: "192.168.1.10", port: 8080 });
  });
});
