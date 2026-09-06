import { OWN_INFO_IDS } from "./constants";

/**
 * Decide which existing adapter objects are orphaned after the current device
 * tree has been (re)created. Pure — the caller performs the actual deletes — so
 * the tricky "what is stale" logic is unit-testable without a live adapter.
 *
 * Three kinds of orphan are collected:
 *  - a whole device sub-tree whose device is no longer configured (rename/removal),
 *  - the legacy `<device>.apps` node the old adapter created and 0.5.x does not,
 *  - a `<device>.keys.<Key>` state whose key is no longer part of the device's
 *    type (e.g. the TV keys after switching a device from "tv" back to "player").
 *
 * The adapter's own objects — `info` and `info.connection` — are never touched.
 * Anything ELSE below `info` is: a hand-edited device row called "info" used to
 * create `info.command` / `info.keys.*` there, and blanket-skipping the whole
 * subtree meant those leftovers stayed for good, even after the row was removed.
 *
 * @param existingIds adapter object ids relative to the namespace (e.g. "ioBroker.keys.Home")
 * @param configuredDeviceIds the id-safe names of the currently configured devices
 * @param validKeysByDevice per configured device, the key names its type currently exposes
 * @returns the relative ids to delete (recursively); de-duplicated
 */
export function planObjectCleanup(
  existingIds: readonly string[],
  configuredDeviceIds: ReadonlySet<string>,
  validKeysByDevice: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const del = new Set<string>();
  for (const id of existingIds) {
    const parts = id.split(".");
    const device = parts[0];
    if (OWN_INFO_IDS.has(id)) {
      continue; // the adapter's own status objects, not a device
    }
    if (device === "info") {
      // Leftover from a hand-edited device row named "info". Collect the topmost
      // foreign node (`info.command`, `info.keys`) — the recursive delete takes its
      // children, so listing those separately would only produce failing deletes.
      const child = `info.${parts[1]}`;
      if (!OWN_INFO_IDS.has(child)) {
        del.add(child);
      }
      continue;
    }
    if (!configuredDeviceIds.has(device)) {
      del.add(device); // whole orphaned device tree — recursive delete drops the children
      continue;
    }
    if (parts[1] === "apps") {
      del.add(`${device}.apps`); // legacy node the old adapter created
    } else if (parts[1] === "keys" && parts.length === 3) {
      const valid = validKeysByDevice.get(device);
      if (valid && !valid.has(parts[2])) {
        del.add(`${device}.keys.${parts[2]}`); // key no longer part of this device's type
      }
    }
  }
  return [...del];
}

/**
 * Find the objects that still carry a `native` attribute this adapter does not write.
 *
 * Every object this adapter creates declares `native: {}`. The pre-0.5.0 adapter wrote
 * `native: { url: "keys/Home" }` on every key state, and `extendObject` merges — an
 * attribute only the stored object carries survives forever, and writing `null` would store
 * `null` rather than remove it. So an installation upgraded from <= 0.4.0 keeps a dead
 * attribute on every key datapoint until something writes the object in full.
 *
 * Pure: the caller performs the writes, and it decides nothing about `common` — the object
 * is handed back as it was read so the full write can preserve it (that is where
 * `common.custom`, the user's own history configuration, lives).
 *
 * @param objects the adapter's objects, keyed relative to the namespace
 * @param deleted ids the orphan sweep is removing — writing to those would be pointless
 * @returns the ids and objects to rewrite without their stale native attributes
 */
export function planNativePrune(
  objects: ReadonlyMap<string, ioBroker.Object>,
  deleted: ReadonlySet<string> = new Set(),
): [string, ioBroker.Object][] {
  const stale: [string, ioBroker.Object][] = [];
  for (const [id, obj] of objects) {
    if (deleted.has(id) || [...deleted].some(prefix => id.startsWith(`${prefix}.`))) {
      continue;
    }
    if (obj.native && typeof obj.native === "object" && Object.keys(obj.native).length > 0) {
      stale.push([id, obj]);
    }
  }
  return stale;
}
