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
 * The adapter's own `info` channel is never touched.
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
    if (device === "info") {
      continue; // the adapter's own info channel, not a device
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
