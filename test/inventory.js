/* global describe, it, before, after */
"use strict";
// Generates the adapter's complete object inventory from fixtures and proves that
// an update reaches every object of an existing installation.
//
// Suite 1 "object inventory": start the adapter in the throwaway js-controller,
//   drive it with fixtures covering EVERY device type the adapter supports
//   (feedFixtures), then dump every <adapter>.0.* object to
//   test/objects.inventory.json in the ioBroker object-structure bot's format.
// Suite 2 "upgrade from the previous release" (only when INVENTORY_PREVIOUS is
//   set — pre-release.py exports the last tag's inventory): seed the previous
//   objects BEFORE start, start, feed, then assert that every object carries the
//   current common (every field) and object type, and that removed objects are gone.
// Suite "counterpart gone and back" (round 87): cut every counterpart, hold, bring it
//   back — the adapter shows it in OUTAGE_SHOWN, deletes and writes no object, and
//   logs nothing above debug.
// Suite "a name that is the adapter's own" (round 87): a device named `info` (feedReservedNames)
//   leaves `info` and everything below it as a fresh installation has it.
// Suites "chosen network address" / "missing network address" (round 87, only with a
//   `type: "ip"` field): the chosen address is the only one used and strangers get no
//   answer; a missing one falls back to every address with exactly one warning.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");
const { tests } = require("@iobroker/testing");

const ADAPTER_DIR = path.join(__dirname, "..");
const ADAPTER = require(path.join(ADAPTER_DIR, "io-package.json")).common.name;
const NS = `${ADAPTER}.0.`;
// An object is written at most three times in one start: created, its name refreshed, enriched once after
// discovery. More is churn — every write goes to the database and to every subscriber (round 60, measured
// 2026-09-28 over the fleet: 1-3 everywhere, 251 for an object whose stored key flipped on every resync).
const MAX_OBJECT_WRITES = 3;
const INVENTORY = path.join(__dirname, "objects.inventory.json");
// Value dumps for the readable-values judge (`iobroker-adapter-checks values`, gate D08 + CI job): the states
// after the fixture run, and the objects once more from a run in a second system language. Generated, not
// committed (.gitignore) — timestamps and counters would make a golden file drift on every run.
const STATES_INVENTORY = path.join(__dirname, "states.inventory.json");
const OBJECTS_SECOND_LANGUAGE = path.join(__dirname, "objects.inventory.de.json");
const FIRST_LANGUAGE = "en";
const SECOND_LANGUAGE = "de";
const VOLATILE = ["ts", "from", "user", "acl"];
// Key order carries no meaning in an ioBroker object: extendObject keeps the key order an existing
// object already has, while adapter-core's I18n.getTranslatedObject builds its own — the same eleven
// texts in another order are the same name. Arrays keep their order.
const canonical = v =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map(k => [k, x[k]]),
        )
      : x,
  );
// How long the upgrade suite keeps watching after its verdict: a write in that window means the wait ended before
// the adapter did (round 61, measured 2026-09-29 over the fleet: none in 10 s at HEAD; parcelapp's old wait judged
// 5 ms before the first of 187 writes).
const SETTLE_MS = 10000;
const INSTANCE_OBJECTS = new Set(
  (require(path.join(ADAPTER_DIR, "io-package.json")).instanceObjects ?? []).map(o => `${NS}${o._id}`),
);
// Round 62: every adapter start loads test/resource-probe.js (fleet master) FIRST; at its exit it records what the
// adapter or one of its libraries left open after onUnload, and the run fails on any of it (the after() at the end).
const RESOURCE_PROBE = path.join(__dirname, "resource-probe.js");
const RESOURCE_DIR = fs.mkdtempSync(path.join(require("node:os").tmpdir(), `${ADAPTER}-resources-`));
// Round 62: the adapter's read-only states (`common.write: false`) — only the adapter writes them, so it compares them
// in memory; a database read of one in the quiet window after the verdict is a finding, and so is a single read of one at
// any time (Round 77) — the start fills the memory with one bulk getStatesAsync.
const READ_ONLY = new Set();
/**
 * The environment of every adapter start: the resource probe first, then the test hooks of this adapter.
 *
 * @param {...string} hooks absolute paths of `--require` hooks (fixture servers, DNS)
 */
function adapterEnv(...hooks) {
  return {
    NODE_OPTIONS: [RESOURCE_PROBE, ...hooks].map(file => `--require ${file}`).join(" "),
    RESOURCE_PROBE_DIR: RESOURCE_DIR,
    RESOURCE_PROBE_NS: NS,
  };
}

// Round 87 (krobi 2026-10-02 23:26): the suite "counterpart gone and back" cuts every counterpart with
// test/network-hook.js (fleet master), the LAST hook of its starts; the switch is on while OUTAGE_FLAG exists.
const NETWORK_HOOK = path.join(__dirname, "network-hook.js");
const OUTAGE_FLAG = path.join(RESOURCE_DIR, "outage");
// How long the adapter may take to show the outage, and to show the return.
const OUTAGE_DEADLINE_MS = 300000;
// Once the adapter shows the outage, every counterpart stays gone at least this long and at least as long again as the
// adapter took to show it — several of its own cycles, so a deletion after N missed cycles falls inside the window.
const OUTAGE_HOLD_MS = 30000;
// Round 87 (krobi 2026-10-03 00:27, 11:38): the address the user picks in the instance settings (jsonConfig `type: "ip"`)
// is the only one the adapter listens, sends and connects on — the cloud included; one the host does not carry falls back
// to every address with exactly one warning. ADDRESS_KEY is the native key of that field, undefined where the adapter
// offers no choice; CHOSEN_ADDRESS the first non-internal IPv4 of this machine (loopback is internal — several adapters
// treat it as missing); MISSING_ADDRESS one no machine carries (TEST-NET-1, RFC 5737).
const ADDRESS_KEY = (() => {
  const file = path.join(ADAPTER_DIR, "admin", "jsonConfig.json");
  const find = node => {
    for (const [key, value] of Object.entries(node?.items ?? {})) {
      if (value?.type === "ip") {
        return key;
      }
      const inner = find(value);
      if (inner) {
        return inner;
      }
    }
    return undefined;
  };
  return fs.existsSync(file) ? find(JSON.parse(fs.readFileSync(file, "utf8"))) : undefined;
})();
const CHOSEN_ADDRESS = Object.values(require("node:os").networkInterfaces())
  .flat()
  .find(i => (i.family === "IPv4" || i.family === 4) && !i.internal)?.address;
const MISSING_ADDRESS = "192.0.2.1";

/**
 * Every object write of the adapter in this suite, and which of them changed nothing (round 61). An unchanged
 * rewrite still goes to the database and to every subscriber — the adapter writes only what differs. The FIRST
 * write of an `instanceObjects` entry is js-controller's own (`_createInstancesObjects` extends every entry before
 * `onReady`, 7.2.2) and not the adapter's choice. Called as the suite's first await, so the start is watched from
 * its first write; the known content comes from the database, a seed included.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function watchObjectWrites(harness) {
  const watch = { writes: new Map(), peak: new Map(), unchanged: [], deleted: [], times: [], unchangedIndicators: [] };
  const known = new Map();
  const roles = new Map();
  const states = new Map();
  const content = obj => {
    const { ts, from, user, ...rest } = obj;
    return canonical(rest);
  };
  harness.on("objectChange", (id, obj) => {
    if (!id.startsWith(NS)) {
      return;
    }
    if (!obj) {
      watch.deleted.push(id);
      known.delete(id);
      roles.delete(id);
      return;
    }
    roles.set(id, obj.common?.role);
    if (obj.type === "state" && obj.common?.write === false) {
      READ_ONLY.add(id);
    } else {
      READ_ONLY.delete(id);
    }
    const now = content(obj);
    if (obj.from === `system.adapter.${ADAPTER}.0`) {
      const n = (watch.writes.get(id) ?? 0) + 1;
      watch.writes.set(id, n);
      watch.peak.set(id, Math.max(watch.peak.get(id) ?? 0, n));
      watch.times.push([id, Date.now()]);
      if (known.get(id) === now && !(n === 1 && INSTANCE_OBJECTS.has(id))) {
        watch.unchanged.push(id);
      }
    }
    known.set(id, now);
  });
  // Round 62: an indicator state (`indicator.*`) is written only on a change (read-only: compared in memory,
  // writable: setStateChangedAsync) — a write that changes nothing is a finding. Compared is what js-controller
  // 7.2.2 compares in setStateChangedAsync: val strictly, ack, q, c; an object value always counts as changed.
  harness.on("stateChange", (id, state) => {
    if (!id.startsWith(NS) || !state || state.from !== `system.adapter.${ADAPTER}.0`) {
      return;
    }
    const now =
      state.val !== null && typeof state.val === "object" ? null : canonical([state.val, state.ack, state.q, state.c]);
    if (now !== null && states.get(id) === now && String(roles.get(id)).startsWith("indicator")) {
      watch.unchangedIndicators.push(id);
    }
    states.set(id, now);
  });
  // Round 64: a restart the harness plays (playControllerRestarts) is a new start — the per-start counts begin again,
  // the known object content stays (it is the database's).
  watch.newStart = () => {
    watch.writes.clear();
    states.clear();
  };
  const list = await harness.objects.getObjectListAsync({ startkey: NS, endkey: `${NS}香` });
  for (const row of list.rows) {
    if (row.value) {
      known.set(row.id, content(row.value));
      roles.set(row.id, row.value.common?.role);
      if (row.value.type === "state" && row.value.common?.write === false) {
        READ_ONLY.add(row.id);
      }
    }
  }
  return watch;
}

/** Objects the adapter creates for the fixture configuration: 2 own + (3 + 16) + (3 + 31). */
const EXPECTED_OBJECTS = 55;

/**
 * Adapter-specific: wait until the object tree is complete.
 *
 * The adapter's objects come from its configuration alone — one emulated Roku of every type in FIXTURE_NATIVE — and
 * everything is created in onReady, so there is nothing to feed. The writes are concurrent, so "the tree stopped
 * growing at the expected count" is the state to wait for: settling early would produce a green inventory that is
 * missing exactly the datapoints this gate exists for.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function feedFixtures(harness) {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const n = (await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` })).rows.length;
    stable = n === last ? stable + 1 : 0;
    last = n;
    if (n >= EXPECTED_OBJECTS && stable >= 3) return;
  }
  throw new Error(`object tree did not settle at ${EXPECTED_OBJECTS} objects (last count ${last})`);
}

/**
 * Adapter-specific: wait until the adapter has really DONE its work on top of the SEEDED tree.
 * Suite 2 only — suite 1 needs nothing beyond feedFixtures. Name it after the adapter's own cycle
 * (parcelapp: `waitForCompletedPoll`); what matters is the criterion, not the name.
 *
 * Suite 2 seeds the previous release's OBJECTS before the start, so a wait that looks for objects
 * — which is exactly what feedFixtures does in suite 1 — is satisfied on its first look, and the
 * assertions run before the adapter has written anything. Suite 1 has the same blind spot wherever
 * ALL objects come from `instanceObjects`: js-controller creates them before `ready` fires, so an
 * object wait proves nothing about the adapter; there suite 1 also waits for a value the adapter
 * itself writes (for example `info.connection`, acknowledged). Measured public-holidays 2026-09-25:
 * with the ready handler never registered, suite 1 stayed green on the object wait alone. Measured parcelapp
 * 2026-09-07 (its first upgrade run): the assertion fired 13 ms after `onReady`, and the adapter's
 * only poll attempt hit the fixture server AFTER `after()` had already closed it. The suite then
 * reported "desc still undefined" for the three datapoints whose description was new — which reads
 * exactly like an adapter that fails to reach existing objects, while in truth nothing had run yet.
 * A catalog adapter, whose feedFixtures is `void harness`, has NO wait here at all.
 *
 * The seed uses `setObjectAsync` — objects only, never a VALUE. State values are therefore the one
 * signal it cannot fake.
 *
 * ⚠️ Cover EVERY object area the suites check, and wait there for the value the cycle writes LAST.
 * The wait ends as soon as every id below has a state; whatever the cycle writes after the last waited
 * id is checked unwaited. Measured on parcelapp 2026-09-25 (CI run 36123917452): the wait watched
 * `.carrier` (written early, per package), `updateSummary` wrote the three `summary.*` values a few
 * milliseconds after the check, and the suite reported "desc still …" only there — green locally,
 * red in CI. A value counts as written once its state exists (`""` included where the adapter really
 * writes it — the seed never writes values).
 *
 * ⚠️ Pick ids the adapter writes UNCONDITIONALLY on every cycle. A value behind a condition hangs
 * the wait until the deadline: parcelapp's `lastUpdated` writes only when the tracking data really
 * changed, and `info.connection` is no substitute either — it flips right after the API call and
 * before the per-device states are written.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function waitForAdapterWork(harness) {
  // Adapter-specific: a start is done once it wrote its start line — after every device's tree, its key reset, the
  // orphan sweep and discovery — and info.connection carries what that line says: green only with every configured
  // Roku listening and discovery up ("Emulating N Roku device(s), advertising on …"), yellow for "N of M", a missing
  // discovery, or no Roku running at all. Only the lines after the LAST "starting." count — a restart the host played
  // ends an earlier start before its line.
  const deadline = Date.now() + 60000;
  for (;;) {
    const own = harness.getLogs().filter(l => l.from === `${ADAPTER}.0`);
    const start = own.findLastIndex(l => l.message.includes("starting. Version"));
    const done = own
      .slice(start + 1)
      .find(l => /Emulating \d+|No emulated Roku is running|No Roku device configured/.test(l.message));
    if (done) {
      const green = /Emulating \d+ Roku device\(s\), advertising on /.test(done.message);
      const state = await harness.states.getState(`${NS}info.connection`);
      if (state && state.ack && state.val === green) return;
    }
    if (Date.now() > deadline) {
      throw new Error(`no completed start — last start line: ${done ? done.message : "none"}`);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/**
 * Adapter-specific config the fixtures need: one emulated Roku of every type the adapter can create — a player
 * (16 remote keys) and a TV (those plus the 15 TV keys). The ports are far from the real-Roku default 8060, so the run
 * does not fight over it with whatever else is on the box; the identities are fixed, so two runs produce a
 * byte-identical inventory.
 */
const FIXTURE_NATIVE = {
  bind: "0.0.0.0",
  devices: [
    { name: "Player", port: 18060, type: "player", uuid: "fixture0000000000000000000player" },
    { name: "TV", port: 18061, type: "tv", uuid: "fixture00000000000000000000000tv" },
  ],
};
/**
 * Round 66 (reported by dl-manager): every datapoint of the previous release this release moves under a new id —
 * previous full id → current full id (adapter-specific like FIXTURE_NATIVE, may be computed). The recording is the
 * user's and goes on with the moved datapoint (krobi 2026-09-02); the upgrade suite checks that it arrived there.
 */
const MOVES = {};
/**
 * Round 87: adapter-specific like FIXTURE_NATIVE — the states that show an outage of EVERY counterpart, each with the
 * value it takes then (ids without the namespace, e.g. `{ "info.connection": false }` plus each device's reachability).
 * The return is shown once each has its value from before the cut again. Keep the fixture's cycles short through
 * FIXTURE_NATIVE: the outage holds for several of them.
 */
const OUTAGE_SHOWN = {};
/**
 * Round 87 (krobi 2026-10-03 00:04: "KEIN adapter jemals darf info schreiben"): adapter-specific like feedFixtures —
 * make the adapter meet a device, account or entry whose name is `info`, and wherever the adapter builds an id from
 * something a device or service reports (a model, a type, a host), one that reports `info` there; the same way
 * feedFixtures feeds, and wait until the adapter has handled it. The suite "a name that is the adapter's own" then
 * checks that `info` and everything below it are still the adapter's own objects. Required wherever the manifest declares
 * an `info` object.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function feedReservedNames(harness) {
  // fakeroku's devices come from its configuration alone (FIXTURE_NATIVE), so a Roku named "info" comes the same way:
  // a hand-edited native.devices row — the device manager refuses the name. The host restarts the instance on a changed
  // instance object; the harness has no host, so this plays it: stop, the settings with the row, start.
  await withinDeadline(harness.stopAdapter(), STOP_DEADLINE_MS, "the adapter did not stop for the reserved name");
  await harness.states.setState(`system.adapter.${ADAPTER}.0.alive`, {
    val: false,
    ack: true,
    from: "system.host.testing",
  });
  await resetInstanceNative(harness, {
    ...FIXTURE_NATIVE,
    devices: [...FIXTURE_NATIVE.devices, { name: "info", port: 18062, type: "player" }],
  });
  await new Promise(resolve => setTimeout(resolve, RESTART_DELAY_MS));
  harness._adapterExit = undefined;
  await withinDeadline(
    harness.startAdapterAndWait(false, adapterEnv()),
    START_DEADLINE_MS,
    "the adapter did not come back with the reserved name",
  );
}

async function dumpObjects(harness) {
  // The range starts at "<adapter>.0." — the instance root object itself is not part of the tree.
  const list = await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` });
  const out = {};
  for (const row of list.rows.sort((a, b) => a.id.localeCompare(b.id))) {
    const obj = { ...row.value };
    for (const key of VOLATILE) delete obj[key];
    out[row.id] = obj;
  }
  return out;
}

/**
 * Set the throwaway controller's system language — what the adapter reads from `system.config`.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {string} language an ioBroker language code
 */
async function setSystemLanguage(harness, language) {
  const config = await harness.objects.getObject("system.config");
  config.common.language = language;
  await harness.objects.setObject("system.config", config);
}

/**
 * Dump the value of every state of the instance: `{ "<id>": { val, ack } }`, sorted. The states client has no
 * `getKeysAsync` — `getKeys`/`getStates` (like `getObject`/`setObject`) return a promise without a callback.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function dumpStates(harness) {
  const keys = (await harness.states.getKeys(`${NS}*`)).sort();
  const values = await harness.states.getStates(keys);
  const out = {};
  keys.forEach((key, i) => {
    if (values[i]) out[key] = { val: values[i].val, ack: values[i].ack };
  });
  return out;
}

/**
 * The throwaway js-controller keeps its instance object between runs, and changeAdapterConfig only
 * EXTENDS native — a key that an older version of this adapter wrote would survive and trigger the
 * start-up key migration and with it a host restart (played since round 64) in every suite. Null every key the
 * fixture does not know, then apply the fixture (null is the post-migration state of a renamed key).
 * changeAdapterConfig encrypts the `encryptedNative` keys, but merges with alcalzone-shared `extend` (round 66, reported
 * by dl-manager): a list goes element-wise into the one already there (the old tail stays, an empty list resets
 * nothing), and under a new key it becomes an object with numeric keys. Every key but an encrypted one goes in again
 * as a whole.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {Record<string, unknown>} native the instance's native for this start (FIXTURE_NATIVE, or one computed per run)
 */
async function resetInstanceNative(harness, native = FIXTURE_NATIVE) {
  const id = `system.adapter.${ADAPTER}.0`;
  const instance = await harness.objects.getObjectAsync(id);
  const stale = {};
  for (const key of Object.keys(instance?.native ?? {})) {
    if (!Object.hasOwn(native, key)) stale[key] = null;
  }
  await harness.changeAdapterConfig(ADAPTER, { native: { ...stale, ...native } });
  const written = await harness.objects.getObjectAsync(id);
  for (const [key, value] of Object.entries(native)) {
    if (!written.encryptedNative?.includes(key)) written.native[key] = value;
  }
  await harness.objects.setObjectAsync(id, written);
}

/**
 * Round 71 (reported by dl-manager): @iobroker/testing clears only the database and the log directory before a suite;
 * the instance's data folder (`utils.getAbsoluteInstanceDataDir`, `iobroker-data/<adapter>.0` under the test directory)
 * survives every suite and every run. A file the fresh-install suite wrote was still there when the upgrade suite
 * started, and hid the move of the seeded previous objects into that file — the suite stayed green without the move
 * ever running. A fresh installation has no data folder, so each suite starts without one; the second start of
 * `playControllerRestarts` keeps it, as a real host does.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
function clearInstanceData(harness) {
  if (typeof harness.testDir !== "string") {
    throw new Error("the harness no longer carries testDir — clearInstanceData cannot find the instance data folder");
  }
  fs.rmSync(path.join(harness.testDir, "iobroker-data", `${ADAPTER}.0`), { recursive: true, force: true });
}

/**
 * js-controller 7.2.2 restarts an instance on EVERY change of its instance object while it runs (controller main.ts,
 * objects `change` handler: `stopInstance`, then `startInstance` after `stopTimeout` + 2.5 s) — whoever wrote it, the
 * adapter's own settings migration or device table included. The harness has no host; this plays it (round 64): the
 * adapter's first own write while it runs stops it and starts it once more with the same hooks, so what the adapter did
 * after that write in the same start is cut off here as it is on a real host. An own write after that restart is a
 * finding: on a host the instance would restart again, for good. Only the adapter's own writes count (round 66): the
 * suite's resetInstanceNative writes before the start, but on a slow runner its event arrived after the start and
 * stopped a start midway. Each step has a deadline: a harness call that never settles is logged the moment it misses it,
 * and fails the suite in its own words where `await restarts.done` is the open wait (the upgrade suite's order).
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {object | null} watch the suite's write watcher (watchObjectWrites), null in a suite without one
 * @param {...string} hooks the test hooks the suite starts the adapter with (as for adapterEnv)
 */
function playControllerRestarts(harness, watch, ...hooks) {
  const restarts = { count: 0, again: [], done: Promise.resolve() };
  harness.on("objectChange", (id, obj) => {
    if (
      id !== `system.adapter.${ADAPTER}.0` ||
      obj?.from !== `system.adapter.${ADAPTER}.0` ||
      !harness.isAdapterRunning()
    ) {
      return;
    }
    if (restarts.count > 0) {
      restarts.again.push(Date.now());
      return;
    }
    restarts.count++;
    restarts.done = (async () => {
      await withinDeadline(
        harness.stopAdapter(),
        STOP_DEADLINE_MS,
        "the adapter did not stop after it changed its instance object",
      );
      watch?.newStart();
      // What the host does when the process exits: `alive` false (a start that still sees it true ends with
      // ADAPTER_ALREADY_RUNNING, exit code 7), then the start after stopTimeout + 2.5 s.
      await harness.states.setState(`system.adapter.${ADAPTER}.0.alive`, {
        val: false,
        ack: true,
        from: "system.host.testing",
      });
      await new Promise(resolve => setTimeout(resolve, RESTART_DELAY_MS));
      // @iobroker/testing refuses a second start of one harness ("already been used"); the host starts the same
      // instance again — reset the exit marker, and fail loudly should the harness no longer keep it there.
      harness._adapterExit = undefined;
      assert.ok(
        !harness.didAdapterStop(),
        "@iobroker/testing changed its exit marker — the restart play needs a new form",
      );
      await withinDeadline(
        harness.startAdapterAndWait(false, adapterEnv(...hooks)),
        START_DEADLINE_MS,
        "the adapter did not come back after the restart",
      );
    })();
    // Awaited by the suite later — a wait before that (feedFixtures) fails first on an adapter that hangs in its stop,
    // so a missed deadline is logged the moment it happens (and never counts as an unhandled rejection).
    restarts.done.catch(err => console.error(`restart play failed: ${err.message}`));
  });
  return restarts;
}

/**
 * Round 66: the promise's value, or an error naming what hung once the deadline has passed.
 *
 * @param {Promise<unknown> | undefined} promise the harness call
 * @param {number} ms the deadline
 * @param {string} what what did not happen, in the failure message
 */
async function withinDeadline(promise, ms, what) {
  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} (deadline ${ms} ms)`)), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Round 64: the host's wait before it starts a stopped instance again (controller main.ts, `stopTimeout || 500` + 2.5 s). */
const RESTART_DELAY_MS = (require(path.join(ADAPTER_DIR, "io-package.json")).common.stopTimeout || 500) + 2500;
/**
 * Round 66: the restart's deadlines — stopTimeout, the 500 ms the adapter gives pending writes, and the exit; then a start
 * as the harness waits for it (`alive` true). Both together stay far below the suites' before() timeout.
 */
const STOP_DEADLINE_MS = RESTART_DELAY_MS + 2500;
const START_DEADLINE_MS = 30000;
/** Round 64: the recording marker every seeded state carries in `common.custom`, naming the id it was seeded under. */
const RECORDING = "inventory-recording.0";

/**
 * Seed the previous release's objects before the start. Every state carries a recording marker (round 64): what hangs
 * on a datapoint is the user's — it goes on with the SAME datapoint (its id, or the one id a move gives it), never onto
 * a new datapoint, and never decides what the adapter creates, keeps or deletes (that shows up as a leftover or a
 * missing object against the committed inventory).
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {Record<string, ioBroker.Object>} previous the previous release's inventory
 */
async function seedPrevious(harness, previous) {
  for (const [id, obj] of Object.entries(previous)) {
    const common =
      obj.type === "state"
        ? { ...obj.common, custom: { ...obj.common?.custom, [RECORDING]: { enabled: true, origin: id } } }
        : obj.common;
    await harness.objects.setObjectAsync(id, { ...obj, common });
  }
}

/** Round 67: the text a dump puts where the adapter stored a secret encrypted with its installation's secret. */
const ENCRYPTED_MARKER = "<encrypted with the installation secret>";

/**
 * Round 67 (reported by dl-manager): adapter-specific like feedFixtures. The previous release's dump carries
 * ENCRYPTED_MARKER wherever the adapter stored a secret encrypted with its installation's secret — no other controller
 * can read that cipher. Put a working secret back into every such seeded object, the fixture's value in the form the
 * adapter stores it (encrypted like the adapter does, e.g. with encryptPassword), so the upgrade starts on objects the
 * adapter can use. Empty where the dump masks nothing.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function restoreMaskedSecrets(harness) {}

/**
 * Round 75 (reported by dl-manager): adapter-specific like feedFixtures. The previous release's dump carries objects
 * only; what that release kept in the instance data folder (utils.getAbsoluteInstanceDataDir — a store file, a cache,
 * a credential file) is not in it, and clearInstanceData has just emptied the folder. Write here what the previous
 * release left there for the fixture setup, in its format, into the instance data folder under the harness test
 * directory (the same folder clearInstanceData empties), so the upgrade starts where a real installation stands.
 * Empty only where the adapter declares no common.dataFolder (it writes nothing there); with the declaration B02
 * requires a body.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {object} previous the previous release's dump
 */
async function seedInstanceData(harness, previous) {}

/**
 * Round 67: the objects of the namespace that still carry ENCRYPTED_MARKER — read raw from the database, never through
 * dumpObjects (an adapter's dump masks again). Checked right after the restore, before the start: later the adapter may
 * have rewritten or deleted the object, and a clean result would prove nothing about the seeded one.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function maskedSecretsLeft(harness) {
  const list = await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` });
  return list.rows.filter(row => JSON.stringify(row.value).includes(ENCRYPTED_MARKER)).map(row => row.id);
}

/**
 * Round 87: wait until every state named (ids without the namespace) holds the wanted value.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {Record<string, unknown>} wanted id → value
 * @param {string} what what did not happen, in the failure message
 */
async function waitForStates(harness, wanted, what) {
  const deadline = Date.now() + OUTAGE_DEADLINE_MS;
  for (;;) {
    const wrong = [];
    for (const [id, val] of Object.entries(wanted)) {
      const state = await harness.states.getStateAsync(`${NS}${id}`);
      if (state?.val !== val) {
        wrong.push(`${id} = ${JSON.stringify(state?.val)}, want ${JSON.stringify(val)}`);
      }
    }
    if (wrong.length === 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`${what} (deadline ${OUTAGE_DEADLINE_MS} ms):\n${wrong.join("\n")}`);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/**
 * Round 87 (krobi 2026-10-02 23:26: no datapoint is deleted or emptied because a device is gone — the adapter shows
 * whether it is reachable): cut every counterpart, hold, bring it back. Returns when each phase began and the adapter's
 * own log lines of the outage and of the return.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {{ deleted: string[] }} watch the suite's write watcher (watchObjectWrites)
 */
async function playOutage(harness, watch) {
  assert.ok(Object.keys(OUTAGE_SHOWN).length > 0, "OUTAGE_SHOWN names no state — nothing would show the outage");
  const before = {};
  for (const [id, val] of Object.entries(OUTAGE_SHOWN)) {
    before[id] = (await harness.states.getStateAsync(`${NS}${id}`))?.val;
    assert.notStrictEqual(before[id], val, `${id} already shows the outage before the cut`);
  }
  const outage = { cut: Date.now(), deleted: watch.deleted.length, line: harness.getLogs().length };
  fs.writeFileSync(OUTAGE_FLAG, "");
  await waitForStates(harness, OUTAGE_SHOWN, "the adapter did not show the outage");
  const shown = Date.now();
  await new Promise(resolve => setTimeout(resolve, Math.max(OUTAGE_HOLD_MS, shown - outage.cut)));
  fs.rmSync(OUTAGE_FLAG);
  await waitForStates(harness, before, "the adapter did not show the return");
  await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
  outage.lines = harness
    .getLogs()
    .slice(outage.line)
    .filter(l => l.from === `${ADAPTER}.0`);
  return outage;
}

/** Round 87: the network records (`<pid>.net`, test/network-hook.js) present now — a suite reads only the ones after. */
function networkFiles() {
  return new Set(fs.readdirSync(RESOURCE_DIR).filter(f => f.endsWith(".net")));
}

/**
 * Round 87: what the adapter's processes since `seen` listened, bound, joined, sent and connected — a test hook's own
 * entries (`hook`) left out.
 *
 * @param {Set<string>} seen the record files before the suite's start (networkFiles)
 */
function networkUse(seen) {
  return fs
    .readdirSync(RESOURCE_DIR)
    .filter(f => f.endsWith(".net") && !seen.has(f))
    .flatMap(f =>
      fs
        .readFileSync(path.join(RESOURCE_DIR, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map(l => JSON.parse(l)),
    )
    .filter(r => !r.hook);
}

/**
 * Round 87: every place the adapter used another address than `address` — a server on another address, a connection
 * from another source, a UDP socket on every address that joins no group on `address`, a group joined elsewhere, a
 * datagram that leaves from another address or, for multicast, through another interface.
 *
 * @param {object[]} use the records (networkUse)
 * @param {string} address the chosen address
 */
function offTheAddress(use, address) {
  const wrong = [];
  const sockets = new Map();
  for (const r of use) {
    if (r.kind === "listen" && r.host !== address) {
      wrong.push(`listens on ${r.host}:${r.port}`);
    }
    if (r.kind === "connect" && r.localAddress !== address) {
      wrong.push(`connects to ${r.host}:${r.port} from ${r.localAddress ?? "any address"}`);
    }
    if (r.kind === "join" && r.iface !== address) {
      wrong.push(`joins ${r.group} on ${r.iface ?? "the default interface"}`);
    }
    if (r.id !== undefined) {
      const s = sockets.get(r.id) ?? { joins: 0, egress: [], sends: [] };
      if (r.kind === "bind") s.bind = r;
      if (r.kind === "join") s.joins++;
      if (r.kind === "egress") s.egress.push(r.iface);
      if (r.kind === "send") s.sends.push(r);
      sockets.set(r.id, s);
    }
  }
  for (const s of sockets.values()) {
    const bound = s.bind?.address;
    if (s.bind && bound !== address && s.joins === 0) {
      wrong.push(`UDP socket on ${bound}:${s.bind.port}`);
    }
    for (const t of s.sends) {
      const multicast = /^2(2[4-9]|3\d)\./.test(t.host);
      if (multicast ? !s.egress.includes(address) : bound !== address) {
        wrong.push(
          `sends to ${t.host}:${t.port} from ${multicast ? (s.egress.at(-1) ?? "the default interface") : (bound ?? "any address")}`,
        );
      }
    }
  }
  return [...new Set(wrong)];
}

/**
 * Round 87 (krobi 2026-10-02 23:52, F-05 of fakeroku as the fleet rule): a client from another network gets no answer —
 * every server and UDP port the adapter opened on `address` is asked once from 127.0.0.1. A TCP reply counts unless it is
 * an HTTP status of 400 or above; any UDP reply counts.
 *
 * @param {object[]} use the records (networkUse)
 * @param {string} address the chosen address
 */
async function askFromAnotherNetwork(use, address) {
  const answered = [];
  const asked = new Set();
  for (const r of use) {
    if (r.kind === "listen" && !asked.has(`tcp ${r.port}`)) {
      asked.add(`tcp ${r.port}`);
      const reply = await new Promise(resolve => {
        let data = "";
        const socket = require("node:net").connect({ host: address, port: r.port, localAddress: "127.0.0.1" });
        const wait = setTimeout(() => socket.destroy(), 1500);
        socket.on("connect", () => socket.write("GET / HTTP/1.0\r\n\r\n"));
        socket.on("data", d => (data += d));
        socket.on("error", () => {});
        socket.on("close", () => {
          clearTimeout(wait);
          resolve(data);
        });
      });
      const status = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(reply);
      if (reply && !(status && Number(status[1]) >= 400)) {
        answered.push(`TCP ${address}:${r.port} answered a client from 127.0.0.1`);
      }
    }
    if (r.kind === "bind" && r.port && !asked.has(`udp ${r.port}`)) {
      asked.add(`udp ${r.port}`);
      const reply = await new Promise(resolve => {
        const socket = require("node:dgram").createSocket("udp4");
        const wait = setTimeout(() => {
          socket.close();
          resolve(false);
        }, 1500);
        socket.on("message", () => {
          clearTimeout(wait);
          socket.close();
          resolve(true);
        });
        socket.bind(0, "127.0.0.1", () =>
          socket.send(
            'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ssdp:all\r\n\r\n',
            r.port,
            address,
          ),
        );
      });
      if (reply) {
        answered.push(`UDP ${address}:${r.port} answered a sender from 127.0.0.1`);
      }
    }
  }
  return answered;
}

tests.integration(ADAPTER_DIR, {
  controllerVersion: "stable",
  defineAdditionalTests({ suite }) {
    suite("object inventory", getHarness => {
      let harness;
      let watch;
      let restarts;
      before(async function () {
        this.timeout(120000);
        harness = getHarness();
        clearInstanceData(harness);
        watch = await watchObjectWrites(harness);
        await resetInstanceNative(harness);
        await setSystemLanguage(harness, FIRST_LANGUAGE);
        restarts = playControllerRestarts(harness, watch);
        await harness.startAdapterAndWait(false, adapterEnv());
        await feedFixtures(harness);
        await restarts.done;
        await waitForAdapterWork(harness);
      });

      it("writes test/objects.inventory.json", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        assert.ok(Object.keys(objects).length > 0, "no objects created — fixtures did not reach the adapter");
        fs.writeFileSync(INVENTORY, `${JSON.stringify(objects, null, 2)}\n`);
      });

      it("writes test/states.inventory.json", async function () {
        this.timeout(30000);
        const states = await dumpStates(harness);
        assert.ok(Object.keys(states).length > 0, "no states written — fixtures did not reach the adapter");
        fs.writeFileSync(STATES_INVENTORY, `${JSON.stringify(states, null, 2)}\n`);
      });

      it("writes no object more than MAX_OBJECT_WRITES times", function () {
        const churn = [...watch.peak].filter(([, n]) => n > MAX_OBJECT_WRITES).map(([id, n]) => `${id} ×${n}`);
        assert.deepStrictEqual(churn, [], `objects written more than ${MAX_OBJECT_WRITES} times in one start`);
      });

      it("rewrites no object unchanged", function () {
        const idle = [...new Set(watch.unchanged)];
        assert.deepStrictEqual(idle, [], `objects written without a change:\n${idle.join("\n")}`);
      });

      it("rewrites no indicator state unchanged", function () {
        const idle = [...new Set(watch.unchangedIndicators)];
        assert.deepStrictEqual(idle, [], `indicator states written without a change:\n${idle.join("\n")}`);
      });

      it("restarts at most once for its own instance object", function () {
        assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
      });
    });

    // The same run once more in a second system language: a label that stays the same in both was never
    // translated. A suite of its own — the harness starts an adapter only once per suite (a second
    // startAdapterAndWait in the same suite never resolves), and every suite gets a fresh database.
    suite("second system language", getHarness => {
      let harness;
      let restarts;
      before(async function () {
        this.timeout(120000);
        harness = getHarness();
        clearInstanceData(harness);
        await resetInstanceNative(harness);
        await setSystemLanguage(harness, SECOND_LANGUAGE);
        restarts = playControllerRestarts(harness, null);
        await harness.startAdapterAndWait(false, adapterEnv());
        await feedFixtures(harness);
        await restarts.done;
        await waitForAdapterWork(harness);
      });

      it("restarts at most once for its own instance object", function () {
        assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
      });

      it("writes test/objects.inventory.de.json", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        assert.ok(Object.keys(objects).length > 0, "no objects created — fixtures did not reach the adapter");
        fs.writeFileSync(OBJECTS_SECOND_LANGUAGE, `${JSON.stringify(objects, null, 2)}\n`);
      });
    });

    // The suite "counterpart gone and back" (round 87) is not here: an emulated Roku has no counterpart that can go
    // away — the remotes come to it, and nothing in the adapter could show one of them gone. It enters only with
    // krobi's register entry "counterpart: none" (Gate A14), which the Werkbank asks for.

    // Round 87 (krobi 2026-10-03 00:04): a device, account or entry named `info` never takes the place of the adapter's
    // own `info` channel — `info` and everything below it stay exactly what a fresh installation has.
    suite("a name that is the adapter's own", getHarness => {
      let harness;
      let watch;
      let restarts;
      let live;
      before(async function () {
        this.timeout(180000);
        harness = getHarness();
        clearInstanceData(harness);
        watch = await watchObjectWrites(harness);
        await resetInstanceNative(harness);
        await setSystemLanguage(harness, FIRST_LANGUAGE);
        restarts = playControllerRestarts(harness, watch);
        await harness.startAdapterAndWait(false, adapterEnv());
        await feedFixtures(harness);
        await feedReservedNames(harness);
        await restarts.done;
        await waitForAdapterWork(harness);
        live = await dumpObjects(harness);
      });

      it("keeps its own info channel", function () {
        const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
        const own = id => id === `${NS}info` || id.startsWith(`${NS}info.`);
        const ids = [...new Set([...Object.keys(current), ...Object.keys(live)])].filter(own);
        const taken = ids.filter(id => canonical(live[id] ?? null) !== canonical(current[id] ?? null));
        const gone = [...new Set(watch.deleted)].filter(own);
        assert.deepStrictEqual(
          [...taken, ...gone],
          [],
          `objects below info that differ from a fresh installation or were deleted:\n${[...taken, ...gone].join("\n")}`,
        );
      });

      it("restarts at most once for its own instance object", function () {
        assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
      });
    });

    // Round 87 (krobi 2026-10-03 00:27/00:28, 11:38): with an address chosen, the adapter listens, sends and connects
    // there and nowhere else — the cloud included — and a client from another network gets no answer.
    if (ADDRESS_KEY) {
      suite("chosen network address", getHarness => {
        let harness;
        let restarts;
        let use;
        let strangers;
        before(async function () {
          this.timeout(180000);
          assert.ok(CHOSEN_ADDRESS, "this machine carries no non-internal IPv4 address to choose");
          harness = getHarness();
          clearInstanceData(harness);
          const seen = networkFiles();
          await resetInstanceNative(harness, { ...FIXTURE_NATIVE, [ADDRESS_KEY]: CHOSEN_ADDRESS });
          restarts = playControllerRestarts(harness, null, NETWORK_HOOK);
          await harness.startAdapterAndWait(false, adapterEnv(NETWORK_HOOK));
          await feedFixtures(harness);
          await restarts.done;
          await waitForAdapterWork(harness);
          use = networkUse(seen);
          strangers = await askFromAnotherNetwork(use, CHOSEN_ADDRESS);
        });

        it("uses only the chosen address", function () {
          assert.ok(
            use.length > 0,
            "the network hook recorded nothing — a start without NETWORK_HOOK as its last hook",
          );
          const wrong = offTheAddress(use, CHOSEN_ADDRESS);
          assert.deepStrictEqual(wrong, [], `network use off ${CHOSEN_ADDRESS}:\n${wrong.join("\n")}`);
        });

        it("answers no client from another network", function () {
          assert.deepStrictEqual(strangers, [], `answers to another network:\n${strangers.join("\n")}`);
        });

        it("restarts at most once for its own instance object", function () {
          assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
        });
      });

      // Round 87 (krobi 2026-10-02 23:52, F-06 of fakeroku as the fleet rule): an address the host does not carry —
      // the adapter falls back to every address, keeps working, and says so in exactly one warning.
      suite("missing network address", getHarness => {
        let harness;
        let restarts;
        let lines;
        before(async function () {
          this.timeout(180000);
          harness = getHarness();
          clearInstanceData(harness);
          await resetInstanceNative(harness, { ...FIXTURE_NATIVE, [ADDRESS_KEY]: MISSING_ADDRESS });
          restarts = playControllerRestarts(harness, null, NETWORK_HOOK);
          await harness.startAdapterAndWait(false, adapterEnv(NETWORK_HOOK));
          // The fixtures reach the adapter on every address — that it keeps working. No waitForAdapterWork: a
          // missing address may keep the adapter's state short of green (fakeroku F-06: yellow until changed).
          await feedFixtures(harness);
          await restarts.done;
          lines = harness.getLogs().filter(l => l.from === `${ADAPTER}.0` && l.message.includes(MISSING_ADDRESS));
        });

        it("falls back to every address and warns once", function () {
          const said = lines
            .filter(l => l.level === "warn" || l.level === "error")
            .map(l => `${l.level}: ${l.message}`);
          assert.deepStrictEqual(
            said.length === 1 && said[0].startsWith("warn: "),
            true,
            `lines naming ${MISSING_ADDRESS}:\n${said.join("\n")}`,
          );
        });

        it("restarts at most once for its own instance object", function () {
          assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
        });
      });
    }

    const previousFile = process.env.INVENTORY_PREVIOUS;
    if (previousFile && fs.existsSync(previousFile)) {
      suite("upgrade from the previous release", getHarness => {
        let harness;
        let watch;
        let restarts;
        let verdictAt;
        let maskedLeft;
        const previous = JSON.parse(fs.readFileSync(previousFile, "utf8"));
        before(async function () {
          this.timeout(120000);
          harness = getHarness();
          clearInstanceData(harness);
          watch = await watchObjectWrites(harness);
          // The harness registers its own before() (fresh DB) ahead of this one,
          // so the seed survives and the adapter starts on top of the OLD objects.
          await seedPrevious(harness, previous);
          await seedInstanceData(harness, previous);
          await restoreMaskedSecrets(harness);
          maskedLeft = await maskedSecretsLeft(harness);
          await resetInstanceNative(harness);
          // The inventory was written in FIRST_LANGUAGE: labels an adapter localises itself (`states`)
          // only compare in the same language.
          await setSystemLanguage(harness, FIRST_LANGUAGE);
          restarts = playControllerRestarts(harness, watch);
          await harness.startAdapterAndWait(false, adapterEnv());
          await feedFixtures(harness);
          // On the seeded set feedFixtures may return at once, or wait for a state this run writes
          // itself; waitForAdapterWork adds the adapter's last start step either way.
          await waitForAdapterWork(harness);
          // A migration that wrote the instance object restarts the instance (round 64) — the verdict
          // comes after the second start has done its work.
          await restarts.done;
          await waitForAdapterWork(harness);
          verdictAt = Date.now();
          fs.writeFileSync(
            path.join(RESOURCE_DIR, "window.json"),
            JSON.stringify({ start: verdictAt, end: verdictAt + SETTLE_MS }),
          );
        });

        it("every current object carries the current texts and roles", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const stale = [];
          for (const [id, obj] of Object.entries(current)) {
            const got = live[id];
            if (!got) {
              stale.push(`${id}: missing after upgrade`);
              continue;
            }
            // Every field of `common`, not a chosen few: an adapter writes only what differs (round 61),
            // so every changed field must reach an existing installation.
            for (const f of new Set([...Object.keys(obj.common ?? {}), ...Object.keys(got.common ?? {})])) {
              if (f === "custom") {
                continue; // the user's recording — judged on its own below (round 64)
              }
              if (canonical(got.common?.[f]) !== canonical(obj.common?.[f])) {
                stale.push(`${id}: ${f} still ${JSON.stringify(got.common?.[f])}`);
              }
            }
            // The KIND of the object (state/channel/device/folder/meta) lives one level
            // ABOVE `common`; `common.type` is the VALUE type (string/number/
            // boolean) — something entirely different that merely shares the name. Without
            // this comparison a type migration that never reaches an existing installation
            // stays green: every text matches while every datapoint under the wrongly
            // declared container is a repochecker E2001 (hueemu v1.17.0, `clients` from
            // `meta` to `folder` — found on the live tree, by no gate).
            if (got.type !== obj.type) {
              stale.push(`${id}: type still ${JSON.stringify(got.type)}, want ${JSON.stringify(obj.type)}`);
            }
          }
          assert.deepStrictEqual(stale, [], "objects an update did not reach:\n" + stale.join("\n"));
        });

        it("objects the release removed are gone (no leftovers)", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const leftovers = Object.keys(previous).filter(id => !(id in current) && id in live);
          assert.deepStrictEqual(leftovers, [], "leftover objects:\n" + leftovers.join("\n"));
        });

        it("rewrites no object unchanged", function () {
          const idle = [...new Set(watch.unchanged)];
          assert.deepStrictEqual(idle, [], `objects written without a change:\n${idle.join("\n")}`);
        });

        it("rewrites no indicator state unchanged", function () {
          const idle = [...new Set(watch.unchangedIndicators)];
          assert.deepStrictEqual(idle, [], `indicator states written without a change:\n${idle.join("\n")}`);
        });

        // A kept object that is deleted and created anew makes the suite judge a fresh object, not the
        // upgraded one (hassemu v1.43.1: the stale cleanup removed 18 seeded clients before the dump).
        it("deletes no object the release keeps", function () {
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const lost = [...new Set(watch.deleted)].filter(id => id in previous && id in current);
          assert.deepStrictEqual(lost, [], `kept objects deleted during the upgrade:\n${lost.join("\n")}`);
        });

        it("starts on no masked secret from the previous dump", function () {
          assert.deepStrictEqual(
            maskedLeft,
            [],
            `seeded objects still carry ${ENCRYPTED_MARKER}:\n${maskedLeft.join("\n")}`,
          );
        });

        it("a recording goes on only with its own datapoint", async function () {
          this.timeout(30000);
          const live = await dumpObjects(harness);
          const carriers = new Map();
          for (const [id, obj] of Object.entries(live)) {
            const origin = obj.common?.custom?.[RECORDING]?.origin;
            if (origin) {
              carriers.set(origin, [...(carriers.get(origin) ?? []), id]);
            }
          }
          const wrong = [];
          for (const [origin, ids] of carriers) {
            if (ids.length > 1) {
              wrong.push(`${origin} → ${ids.join(", ")}: one recording on several datapoints`);
            } else if (ids[0] !== origin && origin in live) {
              wrong.push(`${origin} → ${ids[0]}: copied while ${origin} lives on`);
            } else if (ids[0] !== origin && live[ids[0]].common?.type !== previous[origin]?.common?.type) {
              wrong.push(`${origin} → ${ids[0]}: another value type — a new datapoint, not the same one moved`);
            }
          }
          // A state that lives on keeps what hangs on it — the recording is the user's, never destroyed.
          for (const [id, obj] of Object.entries(previous)) {
            if (obj.type === "state" && live[id]?.type === "state" && !carriers.get(id)?.includes(id)) {
              wrong.push(`${id}: its recording is gone although the datapoint lives on`);
            }
          }
          // A state the release moves under a new id (MOVES) takes its recording along (krobi 2026-09-02).
          for (const [from, to] of Object.entries(MOVES)) {
            if (previous[from]?.type === "state" && !carriers.get(from)?.includes(to)) {
              wrong.push(`${from} → ${to}: its recording did not move with the datapoint`);
            }
          }
          assert.deepStrictEqual(wrong, [], `recordings that left their datapoint:\n${wrong.join("\n")}`);
        });

        // What a fresh installation does not have, an upgrade must not have either — whatever made it (round 64:
        // a datapoint created because the old one was recorded is exactly that).
        it("creates nothing a fresh installation lacks", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const extra = Object.keys(live).filter(id => !(id in current));
          assert.deepStrictEqual(extra, [], `objects a fresh installation does not have:\n${extra.join("\n")}`);
        });

        it("restarts at most once for its own instance object", function () {
          assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
        });

        // Last in the suite: a write after the verdict means waitForAdapterWork ended before the adapter did.
        it("writes nothing after the verdict", async function () {
          this.timeout(SETTLE_MS + 5000);
          await new Promise(resolve => setTimeout(resolve, Math.max(0, verdictAt + SETTLE_MS - Date.now())));
          const late = [...new Set(watch.times.filter(([, t]) => t > verdictAt).map(([id]) => id))];
          assert.deepStrictEqual(late, [], `objects written after the verdict:\n${late.join("\n")}`);
        });
      });
    }
  },
});

// Round 62: after every suite, every adapter process of this run has exited — what it left open after onUnload fails
// the run. Every start leaves a marker: no marker means a start without adapterEnv(), a marker without a report a
// process that never reached its exit (killed after a hanging onUnload, or crashed).
after(function () {
  const files = fs.readdirSync(RESOURCE_DIR);
  const starts = files.filter(f => f.endsWith(".start")).map(f => f.slice(0, -".start".length));
  const silent = starts.filter(pid => !files.includes(`${pid}.json`));
  const reports = starts
    .filter(pid => !silent.includes(pid))
    .map(pid => JSON.parse(fs.readFileSync(path.join(RESOURCE_DIR, `${pid}.json`), "utf8")));
  const left = reports.flatMap(r => r.left);
  const reread = reports.flatMap(r =>
    Object.entries(r.quiet)
      .filter(([id]) => READ_ONLY.has(id))
      .map(([id, n]) => `${id} ×${n}`),
  );
  const single = reports.flatMap(r =>
    Object.entries(r.single)
      .filter(([id]) => READ_ONLY.has(id))
      .map(([id, n]) => `${id} ×${n}`),
  );
  fs.rmSync(RESOURCE_DIR, { recursive: true, force: true });
  assert.ok(starts.length > 0, "no adapter start loaded the resource probe — a start without adapterEnv()");
  assert.deepStrictEqual(silent, [], "adapter processes that never reached their exit (killed or crashed)");
  assert.deepStrictEqual(left, [], `left open after onUnload:\n${left.join("\n")}`);
  assert.deepStrictEqual(
    reread,
    [],
    `read-only states read back from the database while nothing changed:\n${reread.join("\n")}`,
  );
  assert.deepStrictEqual(
    single,
    [],
    `read-only states read one by one from the database (one bulk getStatesAsync at the start, then compare in memory):\n${single.join("\n")}`,
  );
});
