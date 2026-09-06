import type { DeviceType } from "../ecp/state-model";
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

/** One configured emulated Roku, normalised. */
export interface DeviceRow {
  /** The name exactly as stored — what the object id and the SSDP identity derive from. */
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
  /** True when the stored port was unusable and the default stands in. */
  readonly portReplaced: boolean;
}

/**
 * Bring a stored port value into the range a server can bind. A hand-edited config (expert
 * mode, CLI) can carry `-5`, `70000` or `8060.5`; without this they reach `server.listen()`
 * and the device fails to start with a message about a port that never existed. The old
 * adapter clamped for the same reason (`Math.min(65535, Math.max(0, parseInt(…) || 9093))`).
 *
 * @param value the stored port value
 * @returns the port to use, or the adapter default when the value is unusable
 */
export function normalizePort(value: unknown): number {
  const port = Math.trunc(Number(value));
  return Number.isFinite(port) && port >= MIN_PORT && port <= MAX_PORT ? port : DEFAULT_ECP_PORT;
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
 * @param raw one element of native.devices
 * @returns the normalised row, or null
 */
export function toDeviceRow(raw: unknown): DeviceRow | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const row = raw as { name?: unknown; port?: unknown; type?: unknown; uuid?: unknown };
  if (typeof row.name !== "string" || row.name.trim().length === 0) {
    return null;
  }
  const identity = resolveDeviceUuid({ name: row.name, uuid: row.uuid });
  const port = normalizePort(row.port);
  return {
    storedName: row.name,
    name: row.name.trim(),
    port,
    type: normalizeType(row.type),
    identity,
    identityReplaced: typeof row.uuid === "string" && row.uuid.length > 0 && row.uuid !== identity,
    portReplaced: row.port !== undefined && port !== Number(row.port),
  };
}

/**
 * Normalise the whole configured list. `null` means the config carries no `devices` key at
 * all — "never configured, or a config we could not read", which is NOT the same as an empty
 * list ("the user deleted everything") and must not trigger the orphan sweep.
 *
 * @param devices the raw `native.devices` value
 * @returns the usable rows, or null when there is no list
 */
export function toDeviceRows(devices: unknown): DeviceRow[] | null {
  if (!Array.isArray(devices)) {
    return null;
  }
  const rows: DeviceRow[] = [];
  for (const raw of devices) {
    const row = toDeviceRow(raw);
    if (row) {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * The object-id path segment of a row — always from the STORED name, so an installation
 * keeps the tree it has until the user actually saves the device.
 *
 * @param row the normalised row
 * @returns the id-safe device path segment
 */
export function deviceObjectId(row: DeviceRow): string {
  return sanitizeId(row.storedName);
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
 * @param devices the full current device list
 * @param candidate the name+port being added/edited
 * @param candidate.name the candidate device name
 * @param candidate.port the candidate ECP port
 * @param exceptIndex the list position to ignore (the device being edited), or -1
 * @returns a translated clash message, or null if free
 */
export function findClash(
  devices: readonly { name: string; port: number }[],
  candidate: { name: string; port: number },
  exceptIndex: number,
): ioBroker.StringOrTranslated | null {
  const name = candidate.name.trim().toLowerCase();
  // The object-tree path is sanitizeId(name); guard the two ways it can go wrong
  // regardless of the plain-name check: a name that sanitizes to a reserved id
  // ("info" would collide with the adapter's own channel), and two different
  // names that sanitize to the SAME id ("My Roku" and "My*Roku" → "My_Roku").
  const id = sanitizeId(candidate.name.trim());
  if (id === "" || RESERVED_IDS.has(id)) {
    return t("deviceNameInvalid");
  }
  for (let i = 0; i < devices.length; i++) {
    if (i === exceptIndex) {
      continue;
    }
    if (devices[i].name.trim().toLowerCase() === name) {
      return t("deviceNameInUse");
    }
    if (sanitizeId(devices[i].name.trim()) === id) {
      return t("deviceNameInvalid");
    }
    if (Number(devices[i].port) === candidate.port) {
      return t("devicePortInUse");
    }
  }
  return null;
}
