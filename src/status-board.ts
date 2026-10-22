import { DEVICE_ERROR_ID, DEVICE_ONLINE_ID } from "./lib/constants";
import { ownRelativeId } from "./lib/pure-helpers";

/** The fleet's reason text while the adapter has nothing to report: it is off, or started and has not tried yet. */
export const UNKNOWN_REASON = "Unknown";

/** What the status board needs from the adapter: its namespace, the one bulk read and the state write. */
export interface StatusHost {
  /** The adapter's namespace (`fakeroku.0`) — the bulk read returns full ids. */
  readonly namespace: string;
  /** The adapter's bulk state read. */
  getStatesAsync(pattern: string): Promise<Record<string, ioBroker.State | null | undefined>>;
  /** The adapter's state write (relative id). */
  setState(id: string, state: ioBroker.SettableState): Promise<unknown>;
}

/** What runs right now, as the adapter derives it from its runtime state — the input of one status pass. */
export interface StatusNow {
  /** Every configured Roku's id-safe path segment with its reason: empty while it listens. */
  readonly devices: readonly (readonly [deviceId: string, reason: string])[];
  /** How many Rokus are configured. */
  readonly total: number;
  /** How many of them listen. */
  readonly online: number;
  /** At least one Roku is configured and all of them listen. */
  readonly allOnline: boolean;
  /** Everything runs — `info.connection`. */
  readonly healthy: boolean;
}

/**
 * The read-only states this adapter writes outside the command hot path — `info.connection`, the device counts, every
 * Roku's status, the key reset at start — each written only when it differs from what it holds.
 */
export class StatusBoard {
  /**
   * Those states as last known, keyed relative to the namespace. Primed once at start by one bulk read, so a restart
   * writes nothing blindly and no such state is ever read one by one; the indicators are kept current by
   * {@link writeIndicator}.
   */
  private readonly lastState = new Map<string, Pick<ioBroker.State, "val" | "ack" | "q">>();

  /**
   * @param host the adapter
   */
  public constructor(private readonly host: StatusHost) {}

  /**
   * Write what runs, in one pass: every Roku's `info.online` and `info.error`, the three device counts and
   * `info.connection` — each only on a change.
   *
   * @param now what runs, derived from the same runtime state
   * @returns once the writes landed (or nothing had to be written)
   */
  public async show(now: StatusNow): Promise<void> {
    await Promise.all([
      ...now.devices.map(([deviceId, reason]) => this.markDevice(deviceId, reason)),
      this.writeIndicator("info.devicesTotal", now.total),
      this.writeIndicator("info.devicesOnline", now.online),
      this.writeIndicator("info.devicesAllOnline", now.allOnline),
      this.writeIndicator("info.connection", now.healthy),
    ]);
  }

  /**
   * Write one Roku's status: online exactly while there is no reason against it.
   *
   * @param deviceId the id-safe device path segment
   * @param reason empty while it listens, `Unknown` while nothing is known, else why it does not listen
   * @returns once both writes landed (or nothing had to be written)
   */
  private async markDevice(deviceId: string, reason: string): Promise<void> {
    await Promise.all([
      this.writeIndicator(`${deviceId}.${DEVICE_ONLINE_ID}`, reason === ""),
      this.writeIndicator(`${deviceId}.${DEVICE_ERROR_ID}`, reason),
    ]);
  }

  /**
   * Show the given Rokus as not running for a reason nobody knows yet, the counts with them, and `info.connection`
   * false — the start stamp (a crash or a power cut runs no shutdown code) and the last write of onUnload.
   * `info.devicesTotal` keeps its value: how many Rokus there are does not change because nobody looks.
   *
   * @param deviceIds the id-safe device path segments to mark
   * @returns once the writes landed (or nothing had to be written)
   */
  public async markOffline(deviceIds: readonly string[]): Promise<void> {
    await Promise.all([
      ...deviceIds.map(id => this.markDevice(id, UNKNOWN_REASON)),
      this.writeIndicator("info.devicesOnline", 0),
      this.writeIndicator("info.devicesAllOnline", false),
      this.writeIndicator("info.connection", false),
    ]);
  }

  /**
   * The Rokus whose status datapoints hold a value — the only ones the start stamp touches, so it creates nothing a
   * tree does not have.
   *
   * @returns their id-safe device path segments
   */
  public storedStatusDevices(): string[] {
    const ids = new Set<string>();
    for (const id of this.lastState.keys()) {
      // A device id carries no dot (sanitizeId), so the status id is everything after the first one.
      const dot = id.indexOf(".");
      const status = id.slice(dot + 1);
      if (dot > 0 && (status === DEVICE_ONLINE_ID || status === DEVICE_ERROR_ID)) {
        ids.add(id.slice(0, dot));
      }
    }
    return [...ids];
  }

  /**
   * Fill {@link lastState} with ONE bulk read of the adapter's own states.
   */
  public async primeStates(): Promise<void> {
    const states = await this.host.getStatesAsync(`${this.host.namespace}.*`);
    this.lastState.clear();
    for (const [id, state] of Object.entries(states)) {
      if (state) {
        this.lastState.set(ownRelativeId(this.host.namespace, id) ?? id, {
          val: state.val,
          ack: state.ack,
          q: state.q,
        });
      }
    }
  }

  /**
   * A state as it was at the bulk read, or as this adapter last wrote it.
   *
   * @param id the state id relative to the namespace
   * @returns the state, or undefined when it holds no value
   */
  public stored(id: string): Pick<ioBroker.State, "val" | "ack" | "q"> | undefined {
    return this.lastState.get(id);
  }

  /**
   * Remember a value this adapter wrote past {@link writeIndicator} (the key reset at start).
   *
   * @param id the state id relative to the namespace
   * @param val the value written with ack
   */
  public remember(id: string, val: ioBroker.StateValue): void {
    this.lastState.set(id, { val, ack: true, q: 0 });
  }

  /**
   * Write a read-only indicator only when it differs from what it holds (`val` strictly, `ack`, `q` — the fields
   * js-controller's own changed-check compares). The one place `info.connection`, the device counts and every Roku's
   * status are written. The value is remembered before the write, so two calls in a row write once; a failed write is
   * forgotten again so the next call retries.
   *
   * @param id the state id relative to the namespace
   * @param val the value to show
   */
  private async writeIndicator(id: string, val: boolean | number | string): Promise<void> {
    const last = this.lastState.get(id);
    if (last && last.val === val && last.ack && !last.q) {
      return;
    }
    this.lastState.set(id, { val, ack: true, q: 0 });
    try {
      await this.host.setState(id, { val, ack: true });
    } catch (e) {
      this.lastState.delete(id);
      throw e;
    }
  }
}
