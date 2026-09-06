"use strict";
// Generates the adapter's complete object inventory from fixtures and proves that
// an update reaches every object of an existing installation.
//
// Suite 1 "object inventory": start the adapter in the throwaway js-controller with one
//   emulated Roku of EVERY device type (a player with the 16 base keys, a TV with the 27),
//   then dump every fakeroku.0.* object to test/objects.inventory.json in the ioBroker
//   object-structure bot's format.
// Suite 2 "upgrade from the previous release" (only when INVENTORY_PREVIOUS is set —
//   pre-release.py exports the last tag's inventory): seed the previous objects BEFORE
//   start, start, feed, then assert that every object carries the current
//   name/desc/role/type/unit and its declared object type, and that removed objects are gone.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");
const { tests } = require("@iobroker/testing");

const ADAPTER_DIR = path.join(__dirname, "..");
const ADAPTER = require(path.join(ADAPTER_DIR, "io-package.json")).common.name;
const NS = `${ADAPTER}.0.`;
const INVENTORY = path.join(__dirname, "objects.inventory.json");
const VOLATILE = ["ts", "from", "user", "acl"];
const COMPARED = ["name", "desc", "role", "type", "unit"];

/**
 * The adapter's objects come from its configuration alone — no device, no cloud. What the
 * inventory needs is therefore one emulated Roku of every type the adapter can create:
 * a player (16 remote keys) and a TV (those plus the 11 TV keys).
 *
 * The ports are deliberately far away from the real-Roku default: a port taken on the build
 * machine would only queue that device for a retry (its objects exist either way), but the
 * run should not fight over 8060 with whatever else is on the box. The identities are fixed
 * so two runs produce a byte-identical inventory.
 */
const FIXTURE_NATIVE = {
  networkInterface: "0.0.0.0",
  devices: [
    { name: "Player", port: 18060, type: "player", uuid: "fixture0000000000000000000player" },
    { name: "TV", port: 18061, type: "tv", uuid: "fixture00000000000000000000000tv" },
  ],
};

/** Objects the adapter creates for the fixture configuration: 2 own + (4 + 16) + (4 + 27). */
const EXPECTED_OBJECTS = 53;

/**
 * Adapter-specific: wait until the object tree is complete.
 *
 * Everything is created in onReady, so there is nothing to feed — but the writes are
 * concurrent, so "the tree stopped growing" is the state to wait for. The expected count is
 * asserted as well: settling early would produce a green inventory that is missing exactly
 * the datapoints this gate exists for.
 *
 * @param {import("@iobroker/testing").TestHarness} harness the running test harness
 */
async function feedFixtures(harness) {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    const n = (await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` })).rows.length;
    stable = n === last ? stable + 1 : 0;
    last = n;
    if (n >= EXPECTED_OBJECTS && stable >= 3) {
      return;
    }
  }
  throw new Error(`object tree did not settle at ${EXPECTED_OBJECTS} objects (last count ${last})`);
}

async function dumpObjects(harness) {
  // The range starts at "<adapter>.0." — the instance root object itself is not part of the tree.
  const list = await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` });
  const out = {};
  for (const row of list.rows.sort((a, b) => a.id.localeCompare(b.id))) {
    const obj = { ...row.value };
    for (const key of VOLATILE) {
      delete obj[key];
    }
    out[row.id] = obj;
  }
  return out;
}

tests.integration(ADAPTER_DIR, {
  defineAdditionalTests({ suite }) {
    suite("object inventory", getHarness => {
      let harness;
      before(async function () {
        this.timeout(180000);
        harness = getHarness();
        await harness.changeAdapterConfig(ADAPTER, { native: FIXTURE_NATIVE });
        await harness.startAdapterAndWait();
        await feedFixtures(harness);
      });

      it("writes test/objects.inventory.json", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        assert.ok(Object.keys(objects).length > 0, "no objects created — fixtures did not reach the adapter");
        fs.writeFileSync(INVENTORY, `${JSON.stringify(objects, null, 2)}\n`);
      });
    });

    const previousFile = process.env.INVENTORY_PREVIOUS;
    if (previousFile && fs.existsSync(previousFile)) {
      suite("upgrade from the previous release", getHarness => {
        let harness;
        const previous = JSON.parse(fs.readFileSync(previousFile, "utf8"));
        before(async function () {
          this.timeout(180000);
          harness = getHarness();
          // The harness registers its own before() (fresh DB) ahead of this one,
          // so the seed survives and the adapter starts on top of the OLD objects.
          for (const [id, obj] of Object.entries(previous)) {
            await harness.objects.setObjectAsync(id, obj);
          }
          await harness.changeAdapterConfig(ADAPTER, { native: FIXTURE_NATIVE });
          await harness.startAdapterAndWait();
          await feedFixtures(harness);
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
            for (const f of COMPARED) {
              if (JSON.stringify(got.common?.[f]) !== JSON.stringify(obj.common?.[f])) {
                stale.push(`${id}: ${f} still ${JSON.stringify(got.common?.[f])}`);
              }
            }
            // The KIND of object (state/channel/device/folder/meta) sits one level
            // ABOVE `common`; the `type` in COMPARED is the VALUE type and something
            // else entirely — they only share a name. Without this comparison a type
            // migration that does not reach an existing installation stays green.
            if (got.type !== obj.type) {
              stale.push(`${id}: type still ${JSON.stringify(got.type)}, want ${JSON.stringify(obj.type)}`);
            }
          }
          assert.deepStrictEqual(stale, [], `objects an update did not reach:\n${stale.join("\n")}`);
        });

        it("objects the release removed are gone (no leftovers)", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const leftovers = Object.keys(previous).filter(id => !(id in current) && id in live);
          assert.deepStrictEqual(leftovers, [], `leftover objects:\n${leftovers.join("\n")}`);
        });
      });
    }
  },
});
