import { type DeviceType, TV_KEYS } from "../ecp/state-model";
import { DEFAULT_ECP_PORT, RESERVED_IDS } from "./constants";
import { resolveDeviceUuid } from "./device-identity";
import { t } from "./i18n";
import { sanitizeId } from "./pure-helpers";

/**
 * Reading `native.devices` — the ONE place that turns a stored config row into the values
 * the adapter works with. The runtime (main.ts) and the device manager both go through it.
 *
 * Why it has to be one place: they used to normalise separately, and the one rule they did
 * not share was the trim. The manager resolved a row's SSDP identity from the trimmed name
 * while the runtime advertised the identity of the untrimmed one, so saving a card — even
 * without changing anything — could hand the remote a different device than the one it was
 * paired with. That is bug A1 of the old adapter, in the one corner 1.4.0 left open.
 *
 * The rule that follows from it: what the user SEES and what gets persisted is the trimmed
 * name, but everything that identifies the device — its object id and its SSDP identity —
 * is derived from the name exactly as stored. Both live in {@link DeviceRow}, so a caller
 * cannot silently pick the wrong one.
 */

/** The port range a TCP server can actually bind. */
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * The port the pre-0.6.0 adapter fell back to for a row whose port was empty or unusable
 * (`parseInt(dev.port) || 9093`). A remote paired with such a device found it there.
 */
const LEGACY_DEFAULT_PORT = 9093;

/**
 * What the adapter's object tree holds right now, as far as the rows need it: the device ids, and
 * the key states below each. Built once per start from the object dump the orphan sweep reads.
 */
export interface DeviceTree {
  /** The top-level device object ids. */
  devices: ReadonlySet<string>;
  /** Per device id, the key names below `<id>.keys`. */
  keys: ReadonlyMap<string, ReadonlySet<string>>;
}

/** A tree with nothing in it — a fresh installation, or a caller that knows none. */
export const EMPTY_TREE: DeviceTree = { devices: new Set(), keys: new Map() };

/**
 * Build the {@link DeviceTree} from the adapter's object ids (relative to the namespace).
 *
 * @param ids the object ids, e.g. "Wohnzimmer", "Wohnzimmer.keys.Home"
 * @param types per id, the object type (only `device` objects count as devices)
 * @returns the tree
 */
export function deviceTreeOf(ids: Iterable<string>, types: (id: string) => string | undefined): DeviceTree {
  const devices = new Set<string>();
  const keys = new Map<string, Set<string>>();
  for (const id of ids) {
    const parts = id.split(".");
    if (parts.length === 1 && types(id) === "device") {
      devices.add(id);
    } else if (parts.length === 3 && parts[1] === "keys") {
      const set = keys.get(parts[0]) ?? new Set<string>();
      set.add(parts[2]);
      keys.set(parts[0], set);
    }
  }
  return { devices, keys };
}

/**
 * The object id the pre-0.6.0 adapter built from a device name: dots and whitespace runs became
 * one `_`, everything else stayed — an umlaut, a bracket, a `#`. The rebuild's {@link sanitizeId}
 * replaces every such character one by one, so the same name leads to a different id.
 *
 * @param name the stored device name
 * @returns the old adapter's object id for it
 */
export function legacyObjectId(name: string): string {
  return name.replace(/[.\s]+/g, "_");
}

/**
 * Can this be one segment of an ioBroker object id? Non-empty, no dot, and nothing js-controller
 * forbids (7.2.2 `FORBIDDEN_CHARS`, common-db tools.ts: letters, digits and `_-/ :!#$%&()+=@^{}|~`).
 *
 * @param id the candidate
 * @returns true if it is a usable id segment
 */
export function isUsableObjectId(id: string): boolean {
  return id.length > 0 && !/[^_\-/ :!#$%&()+=@^{}|~\p{Ll}\p{Lu}\p{Nd}]/u.test(id);
}

/** One configured emulated Roku, normalised. */
export interface DeviceRow {
  /** The name exactly as stored — what the SSDP identity of a row without a `uuid` derives from. */
  readonly storedName: string;
  /** The name to display and to persist on the next write (trimmed). */
  readonly name: string;
  /** ECP port: an integer inside the bindable range. */
  readonly port: number;
  /** The emulated device type. */
  readonly type: DeviceType;
  /** The SSDP identity of this row, resolved from the STORED row. */
  readonly identity: string;
  /** True when the row carried a persisted id the adapters never wrote, and this one replaces it. */
  readonly identityReplaced: boolean;
  /** True when the row carries no usable stored `uuid` — the identity is derived from the name. */
  readonly identityDerived: boolean;
  /** True when the stored port was unusable and the default stands in. */
  readonly portReplaced: boolean;
  /**
   * The object id of this device's tree. Fixed once known: a stored `objectId`, else the tree
   * the installation already has for this row (under today's id or the old adapter's), else the
   * id built from the name. A rename changes the displayed name, never this.
   */
  readonly objectId: string;
}

/**
 * Bring a stored port value into the range a server can bind. A hand-edited config (expert
 * mode, CLI) can carry `-5`, `70000` or `8060.5`; without this they reach `server.listen()`
 * and the device fails to start with a message about a port that never existed. The old
 * adapter clamped for the same reason (`Math.min(65535, Math.max(0, parseInt(…) || 9093))`).
 *
 * @param value the stored port value
 * @param fallback the port for an unusable value (the adapter default, or the old adapter's)
 * @returns the port to use, or the fallback when the value is unusable
 */
export function normalizePort(value: unknown, fallback: number = DEFAULT_ECP_PORT): number {
  const port = Math.trunc(Number(value));
  return Number.isFinite(port) && port >= MIN_PORT && port <= MAX_PORT ? port : fallback;
}

/**
 * The emulated device type of a stored row — anything but the literal "tv" is a player,
 * which also covers a row from before 0.7.0 that carries no type at all.
 *
 * @param value the stored type value
 * @returns the device type
 */
export function normalizeType(value: unknown): DeviceType {
  return value === "tv" ? "tv" : "player";
}

/**
 * Normalise one stored row, or null when it carries no usable name (a row whose name is
 * missing, not a string, or only whitespace — the device manager shows it as an unnamed
 * card and refuses to save it, and the runtime cannot build an object id from it).
 *
 * A row without a stored `type` comes from before 0.7.0 — most of them from the old adapter,
 * which created every key state the remote pressed, TV keys included. Its type is read from the
 * tree it already has: TV keys there mean a TV, or the orphan sweep would delete them (and with
 * them their values, room assignments and history settings). The same rows take the old
 * adapter's fallback port.
 *
 * @param raw one element of native.devices
 * @param tree what the object tree holds (empty: nothing is known)
 * @returns the normalised row, or null
 */
export function toDeviceRow(raw: unknown, tree: DeviceTree = EMPTY_TREE): DeviceRow | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const row = raw as { name?: unknown; port?: unknown; type?: unknown; uuid?: unknown; objectId?: unknown };
  if (typeof row.name !== "string" || row.name.trim().length === 0) {
    return null;
  }
  const identity = resolveDeviceUuid({ name: row.name, uuid: row.uuid });
  const objectId = resolveObjectId(row.name, row.objectId, tree);
  const legacyRow = row.type === undefined;
  const port = normalizePort(row.port, legacyRow ? LEGACY_DEFAULT_PORT : DEFAULT_ECP_PORT);
  const tvKeysInTree = [...(tree.keys.get(objectId) ?? [])].some(key => (TV_KEYS as readonly string[]).includes(key));
  return {
    storedName: row.name,
    name: row.name.trim(),
    port,
    type: legacyRow && tvKeysInTree ? "tv" : normalizeType(row.type),
    identity,
    identityReplaced: typeof row.uuid === "string" && row.uuid.length > 0 && row.uuid !== identity,
    identityDerived: identity !== row.uuid,
    portReplaced: row.port !== undefined && port !== Number(row.port),
    objectId,
  };
}

/**
 * The object id of a row: its stored `objectId`; else a tree the installation already has for
 * it — under the id built from the name today, or under the old adapter's id (an installation
 * upgraded from before 0.6.0 whose name holds an umlaut, a bracket or a double space) — else the
 * id built from the name. Taking the existing tree is what keeps an upgrade from deleting it.
 *
 * @param storedName the name exactly as stored
 * @param stored the stored `objectId`, if any
 * @param tree what the object tree holds
 * @returns the object id
 */
function resolveObjectId(storedName: string, stored: unknown, tree: DeviceTree): string {
  if (typeof stored === "string" && isUsableObjectId(stored)) {
    return stored;
  }
  const current = sanitizeId(storedName);
  if (tree.devices.has(current)) {
    return current;
  }
  const legacy = legacyObjectId(storedName);
  if (isUsableObjectId(legacy) && tree.devices.has(legacy)) {
    return legacy;
  }
  return current;
}

/**
 * Normalise the whole configured list. `null` means the config carries no `devices` key at
 * all — "never configured, or a config we could not read", which is NOT the same as an empty
 * list ("the user deleted everything") and must not trigger the orphan sweep.
 *
 * @param devices the raw `native.devices` value
 * @param tree what the object tree holds (empty: nothing is known)
 * @returns the usable rows, or null when there is no list
 */
export function toDeviceRows(devices: unknown, tree: DeviceTree = EMPTY_TREE): DeviceRow[] | null {
  if (!Array.isArray(devices)) {
    return null;
  }
  const rows: DeviceRow[] = [];
  for (const raw of devices) {
    const row = toDeviceRow(raw, tree);
    if (row) {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * The object-id path segment of a row — fixed once known, see {@link DeviceRow.objectId}.
 *
 * @param row the normalised row
 * @returns the device's object id
 */
export function deviceObjectId(row: DeviceRow): string {
  return row.objectId;
}

/**
 * The lowest free ECP port at or above the real-Roku default, so a newly added device never
 * pre-selects a port another emulated Roku already uses.
 *
 * @param usedPorts the ports already taken by other devices
 * @returns the first free port >= 8060
 */
export function nextFreePort(usedPorts: readonly number[]): number {
  const taken = new Set(usedPorts);
  let port = DEFAULT_ECP_PORT;
  while (taken.has(port)) {
    port++;
  }
  return port;
}

/**
 * A name/port clash against the other devices, as a ready-to-show message — the backend
 * safety net behind the form validator (the dialog validator may not fire in every admin
 * version; this never lets a duplicate through).
 *
 * The object id is judged only for a NEW device: an existing one keeps the id it has, whatever
 * it is renamed to.
 *
 * @param devices the full current device list
 * @param candidate the name+port being added/edited
 * @param candidate.name the candidate device name
 * @param candidate.port the candidate ECP port
 * @param exceptIndex the list position to ignore (the device being edited), or -1 for a new one
 * @returns a translated clash message, or null if free
 */
export function findClash(
  devices: readonly DeviceRow[],
  candidate: { name: string; port: number },
  exceptIndex: number,
): ioBroker.StringOrTranslated | null {
  const name = candidate.name.trim().toLowerCase();
  if (candidate.name.trim() === "") {
    return t("deviceNameInvalid");
  }
  // A new device's tree is built from its name: guard the two ways that can go wrong — a
  // reserved id ("info" would collide with the adapter's own channel), and a different name
  // that maps to an id another device already occupies ("My Roku" and "My*Roku" → "My_Roku").
  const id = exceptIndex === -1 ? sanitizeId(candidate.name.trim()) : null;
  if (id !== null && (id === "" || RESERVED_IDS.has(id))) {
    return t("deviceNameInvalid");
  }
  for (let i = 0; i < devices.length; i++) {
    if (i === exceptIndex) {
      continue;
    }
    if (devices[i].name.toLowerCase() === name) {
      return t("deviceNameInUse");
    }
    // The other device's REAL object id — built from its stored name, taken over from the old
    // adapter, or stored — not an id derived from the name the list displays.
    if (id !== null && deviceObjectId(devices[i]) === id) {
      return t("deviceNameInvalid");
    }
    if (Number(devices[i].port) === candidate.port) {
      return t("devicePortInUse");
    }
  }
  return null;
}
