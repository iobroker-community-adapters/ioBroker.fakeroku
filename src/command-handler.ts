import type { CommandEvent } from "./ecp/ecp-command";
import { commandToStateWrite } from "./ecp/state-model";
import { LogThrottle } from "./lib/log-throttle";
import { RateGate } from "./lib/rate-gate";

/** How long a keypress pulses its keys.<Key> state true before falling back to false. */
export const KEY_PULSE_MS = 50;
/** Safety cap for a held key: a keydown with no matching keyup resets after this. */
export const HOLD_MAX_MS = 30_000;
/** Commands accepted per second and emulated Roku; the excess is dropped (see lib/rate-gate.ts). */
export const MAX_COMMANDS_PER_SECOND = 25;
/** How often at most the dropped-commands warning repeats per device. */
export const RATE_WARN_INTERVAL_MS = 60_000;

/** The emulated Roku a command is for. */
export interface CommandTarget {
  /** The id-safe device path segment. */
  readonly id: string;
  /** The configured device name, for the warning the user reads. */
  readonly name: string;
  /** The key names this device's type carries — only those have a state to write. */
  readonly keys: ReadonlySet<string>;
}

/** What the handler needs from the adapter: writing, the managed timers and the log. */
export interface CommandHost {
  /** Fire-and-forget state write (relative id). */
  writeState(id: string, val: string | boolean): void;
  /** The adapter's managed timeout — undefined while the adapter shuts down. */
  setTimeout(callback: () => void, ms: number): ioBroker.Timeout | undefined;
  /** The adapter's managed clearTimeout. */
  clearTimeout(timer: ioBroker.Timeout): void;
  /** A warning the user should see. */
  warn(message: string): void;
}

/**
 * Turns the ECP commands of every emulated Roku into state writes: `command` / `commandType`, a pulse for a keypress,
 * a hold with a watchdog for keydown/keyup — behind a rate gate per device, the write-flood protection for the states
 * database. Owns its timers and releases them in {@link dispose}.
 */
export class CommandHandler {
  private readonly pulseTimers = new Set<ioBroker.Timeout>();
  /** Per held key id, its watchdog timer — so a keydown without a keyup cannot pin it true forever. */
  private readonly holdTimers = new Map<string, ioBroker.Timeout>();
  private readonly gates = new Map<string, RateGate>();
  private readonly rateWarnings = new LogThrottle(RATE_WARN_INTERVAL_MS);

  /**
   * @param host the adapter's writer, timers and log
   */
  public constructor(private readonly host: CommandHost) {}

  /**
   * Apply a received ECP command to the device's states: record it in `command` / `commandType`, and pulse or hold
   * the standard key if the device carries it. The server logs only what this accepted, so the rate gate covers the
   * log as well as the states database.
   *
   * @param device the emulated Roku the command is for
   * @param cmd the parsed ECP command
   * @returns true if the command was applied, false if the rate gate dropped it
   */
  public apply(device: CommandTarget, cmd: CommandEvent): boolean {
    const write = commandToStateWrite(cmd);
    // The release of a key that is actually HELD never passes the rate gate: a dropped keyup would leave the key true
    // until the watchdog, so the flood protection would falsify the tree. Asked by the held state, not by the request,
    // so a flood of keyups for a key nobody holds still meets the gate.
    const releaseOf = write.holdKey?.value === false ? `${device.id}.keys.${write.holdKey.key}` : null;
    const isRelease = releaseOf !== null && this.holdTimers.has(releaseOf);
    if (!isRelease && !this.admit(device)) {
      return false;
    }
    this.host.writeState(`${device.id}.command`, write.command);
    this.host.writeState(`${device.id}.commandType`, write.commandType);
    // A key only this device's type lacks lands in `command` alone — there is no state to write.
    if (write.pulseKey && device.keys.has(write.pulseKey)) {
      this.pulse(`${device.id}.keys.${write.pulseKey}`);
    } else if (write.holdKey && device.keys.has(write.holdKey.key)) {
      this.hold(`${device.id}.keys.${write.holdKey.key}`, write.holdKey.value);
    }
    return true;
  }

  /** Disarm every timer — the adapter is going down. */
  public dispose(): void {
    for (const timer of this.pulseTimers) {
      this.host.clearTimeout(timer);
    }
    this.pulseTimers.clear();
    for (const timer of this.holdTimers.values()) {
      this.host.clearTimeout(timer);
    }
    this.holdTimers.clear();
    this.gates.clear();
  }

  /**
   * A keypress: true now, false {@link KEY_PULSE_MS} later. A keypress on a HELD key ends the hold, or its watchdog
   * would later write a release for a key the pulse already released.
   *
   * @param id the full key state id
   */
  private pulse(id: string): void {
    this.clearHoldTimer(id);
    this.host.writeState(id, true);
    const timer = this.host.setTimeout(() => {
      if (timer) {
        this.pulseTimers.delete(timer);
      }
      // A keydown inside the pulse window owns the key now — its keyup writes the release.
      if (!this.holdTimers.has(id)) {
        this.host.writeState(id, false);
      }
    }, KEY_PULSE_MS);
    if (timer) {
      this.pulseTimers.add(timer);
    }
  }

  /**
   * A keydown holds the key true until its keyup; a watchdog releases it after {@link HOLD_MAX_MS} when the keyup is
   * lost. A repeated keydown re-arms it.
   *
   * @param id the full key state id
   * @param down true for keydown, false for keyup
   */
  private hold(id: string, down: boolean): void {
    this.host.writeState(id, down);
    this.clearHoldTimer(id);
    if (down) {
      const timer = this.host.setTimeout(() => {
        this.holdTimers.delete(id);
        this.host.writeState(id, false);
      }, HOLD_MAX_MS);
      if (timer) {
        this.holdTimers.set(id, timer);
      }
    }
  }

  /**
   * Disarm the hold watchdog of one key, if it has one.
   *
   * @param id the full key state id
   */
  private clearHoldTimer(id: string): void {
    const timer = this.holdTimers.get(id);
    if (timer) {
      this.host.clearTimeout(timer);
      this.holdTimers.delete(id);
    }
  }

  /**
   * The rate gate: {@link MAX_COMMANDS_PER_SECOND} per device, the excess dropped and reported once per
   * {@link RATE_WARN_INTERVAL_MS}. Every accepted command costs three writes plus one when the pulse ends.
   *
   * @param device the emulated Roku
   * @returns true if the command may be applied
   */
  private admit(device: CommandTarget): boolean {
    const now = Date.now();
    let gate = this.gates.get(device.id);
    if (!gate) {
      gate = new RateGate(MAX_COMMANDS_PER_SECOND, now);
      this.gates.set(device.id, gate);
    }
    if (gate.allow(now)) {
      return true;
    }
    if (this.rateWarnings.due(device.id, now)) {
      this.host.warn(
        `Emulated Roku "${device.name}" receives more than ${MAX_COMMANDS_PER_SECOND} commands per second — dropping the excess (a misbehaving controller?)`,
      );
    }
    return false;
  }
}
