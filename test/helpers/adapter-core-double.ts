import { vi } from "vitest";

/**
 * The `@iobroker/adapter-core` double of the orchestration tests: a minimal Adapter base class carrying an in-memory
 * object/state store, so the real object tree, the cleanup planner and the command→state mapping all run for real.
 * Loaded through `vi.mock("@iobroker/adapter-core", …)` in every `src/main.*.test.ts`.
 */
/**
 * Is this a plain object — the only thing node.extend recurses into besides an array?
 *
 * @param v the value to test
 * @returns true for a plain object
 */
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/**
 * `node.extend(true, target, source)` — the exact merge js-controller performs in its
 * single merge site (objectsInRedisClient `extend(true, oldObj, objClone)`), rebuilt here
 * because the semantics are what several of this adapter's design decisions rest on:
 *
 *  - a key only the OLD object carries SURVIVES, forever, through every further extend;
 *  - a plain object / array source recurses into the old value, everything else replaces it;
 *  - a shorter array does NOT replace a longer one, it merges element-wise;
 *  - `undefined` in the source is skipped, `null` is copied (it does not delete).
 *
 * A flat `{ ...old, ...new }` shows none of that: it drops old keys that really survive.
 * Measured against the real `extend` package on this adapter's own objects — an upgrade
 * from <= 0.4.0 leaves `native.url` on every key state, which the flat spread hid.
 *
 * @param target the stored object (mutated, like js-controller mutates its copy)
 * @param source the partial object handed to extendObject
 * @returns the merged object
 */
const nodeExtend = (target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> => {
  for (const [key, copy] of Object.entries(source)) {
    if (copy === undefined || copy === target) {
      continue;
    }
    if (isPlainObject(copy) || Array.isArray(copy)) {
      const src = target[key];
      const base = Array.isArray(copy) ? (Array.isArray(src) ? (src as unknown[]) : []) : isPlainObject(src) ? src : {};
      target[key] = nodeExtend(base as Record<string, unknown>, copy as Record<string, unknown>);
    } else {
      target[key] = copy;
    }
  }
  return target;
};

/** The adapter base class: an in-memory object and state store with the js-controller semantics the tests need. */
class Adapter {
  public log = { silly: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  public namespace = "fakeroku.0";
  public adapterDir = "/tmp/fakeroku";
  public config: Record<string, unknown> = {};
  public objects = new Map<string, Record<string, unknown>>();
  public states = new Map<string, { val: unknown; ack: boolean }>();
  // Enum membership, the way js-controller stores it: enum id -> the FULL state ids in it.
  // The double needs it because delObject strips an id from every enum it belongs to, which
  // is how a user's room/function assignment disappears without anything saying so.
  public enums = new Map<string, Set<string>>();
  // The ids a write actually REACHED the store for — the start-up reset skips a value that is
  // already there, so counting CALLS alone cannot tell a real write from a skipped one.
  // Both writers append here, setState included — so in a test that also applies a command
  // this list carries the pulse writes as well. Assert on it for the start-up reset, or
  // filter it.
  public written: string[] = [];
  // The instance object's native settings. js-controller builds `config` from exactly this,
  // so the key-migration reads and merges HERE — a double that kept only `config` would let a
  // migration look successful while the stored settings never moved.
  public instanceNative: Record<string, unknown> = {};
  // The instance object's `common`. js-controller never deletes a key the manifest dropped, so
  // this is where a stale host claim survives an update — the double has to keep it separately
  // or the repair would look successful against nothing.
  public instanceCommon: Record<string, unknown> = {};
  // A copy, as the controller answers: only a write reaches the store. A live reference would
  // let a change the code makes on what it read look stored before any write happened.
  public getForeignObjectAsync = vi.fn((id: string) =>
    Promise.resolve(
      id === `system.adapter.${this.namespace}`
        ? { common: structuredClone(this.instanceCommon), native: structuredClone(this.instanceNative) }
        : undefined,
    ),
  );
  // A merge, the way extendForeignObject works: a key set to null is STORED as null, not
  // removed — that is what makes the old key falsy without a second write.
  public extendForeignObjectAsync = vi.fn(
    (id: string, obj: { common?: Record<string, unknown>; native?: Record<string, unknown> }) => {
      if (id === `system.adapter.${this.namespace}`) {
        Object.assign(this.instanceNative, obj.native ?? {});
        Object.assign(this.instanceCommon, obj.common ?? {});
      }
      return Promise.resolve(undefined);
    },
  );
  public on = vi.fn();
  /** Ending the process — the adapter never does it itself: the device manager runs inside the process. */
  public terminate = vi.fn();
  public setState = vi.fn((id: string, state: unknown) => {
    const s = state as { val?: unknown; ack?: boolean };
    const key = id.replace(`${this.namespace}.`, "");
    this.states.set(key, { val: s?.val, ack: s?.ack === true });
    this.written.push(key);
    return Promise.resolve();
  });
  // Deep merge, not a flat spread: js-controller merges with node.extend(true, …), so an
  // attribute the new definition no longer carries survives in the stored object forever.
  // The tests below assert the tree an installation really ends up with, not an idealised one.
  public extendObject = vi.fn((id: string, obj: Record<string, unknown>) => {
    const key = id.replace(`${this.namespace}.`, "");
    const stored = structuredClone(this.objects.get(key) ?? {});
    const merged = nodeExtend(stored, structuredClone(obj));
    this.objects.set(key, merged);
    this.seedDefault(key, merged);
    return Promise.resolve();
  });

  /**
   * Seed `common.def` into the state — but ONLY where the state does not exist yet.
   * js-controller does this in `_setObjectWithDefaultValue` on every object write, which
   * is why re-creating the tree on every start costs nothing: an existing value is never
   * overwritten by a definition. It also decides what an object that was DELETED and put
   * back looks like afterwards — the value is not merely gone, it is back at its default.
   *
   * @param key the object id relative to the namespace
   * @param obj the object as it is now stored
   */
  private seedDefault(key: string, obj: Record<string, unknown>): void {
    const common = obj.common as { def?: unknown } | undefined;
    if (obj.type === "state" && common?.def !== undefined && !this.states.has(key)) {
      this.states.set(key, { val: common.def, ack: true });
    }
  }

  // A full write: the stored object becomes exactly what was handed in. Unlike delObject it
  // touches NEITHER the state value NOR the enum membership — that asymmetry is the whole
  // reason an object can be rewritten in place without costing the user anything.
  public setForeignObject = vi.fn((id: string, obj: Record<string, unknown>) => {
    const key = id.replace(`${this.namespace}.`, "");
    const stored = structuredClone(obj);
    this.objects.set(key, stored);
    this.seedDefault(key, stored);
    return Promise.resolve();
  });
  public getObjectAsync = vi.fn((id: string) => {
    const stored = this.objects.get(id.replace(`${this.namespace}.`, ""));
    return Promise.resolve(stored ? structuredClone(stored) : null);
  });
  public getAdapterObjectsAsync = vi.fn(() => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of this.objects) {
      // Clone, like getObjectAsync next door: js-controller hands out a copy. Handing out
      // the LIVE reference would make an in-place mutation that never reaches the database
      // look like a success in every test that reads the dump back.
      out[`${this.namespace}.${k}`] = structuredClone(v);
    }
    return Promise.resolve(out);
  });
  // The bulk object read of the own namespace (KnownObjects.load): copies with full ids.
  public getObjectListAsync = vi.fn((params: { startkey: string; endkey: string }) => {
    const rows: { id: string; value: unknown }[] = [];
    for (const [k, v] of this.objects) {
      const id = `${this.namespace}.${k}`;
      if (id >= params.startkey && id <= params.endkey) {
        rows.push({ id, value: structuredClone(v) });
      }
    }
    return Promise.resolve({ rows });
  });
  // The bulk read of the own namespace: copies with full ids, like getStatesAsync(`<ns>.*`).
  public getStatesAsync = vi.fn((pattern: string) => {
    const prefix = pattern.replace(/\*$/, "");
    const out: Record<string, unknown> = {};
    for (const [k, v] of this.states) {
      const full = `${this.namespace}.${k}`;
      if (full.startsWith(prefix)) {
        out[full] = structuredClone(v);
      }
    }
    return Promise.resolve(out);
  });
  public delObjectAsync = vi.fn((id: string, opts?: { recursive?: boolean }) => {
    const key = id.replace(`${this.namespace}.`, "");
    for (const k of [...this.objects.keys()]) {
      if (k === key || (opts?.recursive && k.startsWith(`${key}.`))) {
        // js-controller deletes far more than the object. For a state it also drops the
        // VALUE (delForeignState) and strips the id from every enum it belongs to — the
        // user's room and function assignment. A double that only forgets the object
        // describes a world in which deleting and re-creating an object is free.
        if (this.objects.get(k)?.type === "state") {
          this.states.delete(k);
        }
        // removeIdFromAllEnums runs for EVERY object kind — a room assignment often hangs on
        // the device, not on its states.
        for (const members of this.enums.values()) {
          members.delete(`${this.namespace}.${k}`);
        }
        this.objects.delete(k);
      }
    }
    return Promise.resolve();
  });
  public setInterval = vi.fn(() => ({ kind: "interval" }));
  public clearInterval = vi.fn();
  // Every handle is its own object, so a test can tell WHICH timer was cleared.
  private timerSeq = 0;
  public setTimeout = vi.fn((_cb: () => void, _ms: number) => ({ kind: "timeout", seq: ++this.timerSeq }));
  public clearTimeout = vi.fn();
  /** @param _opts the adapter options (unused by the double) */
  constructor(_opts: unknown) {}
}

// getTranslatedObject is what tName/tDesc call for every common.name and desc.
// The stub returns a recognisable object per key, so a test can assert WHICH key
// an object was named from without depending on the wording of a translation.
export const I18n = {
  init: vi.fn(() => Promise.resolve()),
  getTranslatedObject: vi.fn((key: string) => ({ en: key, de: key })),
  // translate is what tText calls for a label in the system language: the key itself, for the same reason.
  translate: vi.fn((key: string) => key),
};

export { Adapter };
