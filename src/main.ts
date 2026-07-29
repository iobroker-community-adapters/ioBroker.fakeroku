import * as utils from "@iobroker/adapter-core";
import type { RokuAdvert } from "./discovery/ssdp-messages";
import { RokuSsdpResponder } from "./discovery/ssdp-responder";
import { deriveUuid } from "./lib/device-identity";

/** Managed timeout for a stuck SSDP start (a busy port 1900 must not hang onReady). */
const SSDP_START_TIMEOUT_MS = 5000;
/** Proactive ssdp:alive interval so controllers find the device without searching. */
const SSDP_NOTIFY_INTERVAL_MS = 300_000;
const DEFAULT_ECP_PORT = 8060;

/**
 * ioBroker.fakeroku — Roku emulator (input side).
 *
 * Emulates one or more Roku devices on the LAN so that ECP/SSDP remotes
 * (Logitech Harmony, Sofabaton X1, the Roku app) trigger events in ioBroker.
 *
 * Milestone 1: lifecycle + interface-bound SSDP discovery. The ECP HTTP server +
 * device-info and the command/keys data model follow in milestones 2–3.
 */
export class Fakeroku extends utils.Adapter {
  private ssdp: RokuSsdpResponder | undefined;
  private notifyTimer: ioBroker.Interval | undefined;

  /**
   * @param options adapter options passed through by js-controller
   */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({
      ...options,
      name: "fakeroku",
    });

    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  /** Start the interface-bound SSDP responder for every configured device. */
  private async onReady(): Promise<void> {
    try {
      await this.setState("info.connection", { val: false, ack: true });

      const interfaceIp = this.config.networkInterface;
      if (!interfaceIp) {
        this.log.warn("No network interface selected — SSDP discovery disabled. Choose one in the adapter settings.");
        return;
      }

      const devices: RokuAdvert[] = (this.config.devices ?? [])
        .filter(d => d && typeof d.name === "string" && d.name.length > 0)
        .map(d => ({ uuid: deriveUuid(d.name), port: Number(d.port) || DEFAULT_ECP_PORT }));

      if (devices.length === 0) {
        this.log.warn("No emulated Roku devices configured.");
        return;
      }

      this.ssdp = new RokuSsdpResponder({ devices, interfaceIp, logger: this.log });
      await this.startWithTimeout(this.ssdp.start(), SSDP_START_TIMEOUT_MS);
      this.ssdp.announce();
      this.notifyTimer = this.setInterval(() => this.ssdp?.announce(), SSDP_NOTIFY_INTERVAL_MS);

      await this.setState("info.connection", { val: true, ack: true });
      this.log.info(`Emulating ${devices.length} Roku device(s) on ${interfaceIp}`);
    } catch (e) {
      this.log.error(`onReady failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Bound await: reject if the SSDP start doesn't settle in time, so a stuck
   * port-1900 bind degrades to "discovery off" instead of hanging the adapter.
   *
   * @param promise the SSDP start promise
   * @param ms the timeout in milliseconds
   * @returns a promise that settles with the start result or a timeout error
   */
  private startWithTimeout(promise: Promise<void>, ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = this.setTimeout(() => reject(new Error(`SSDP start timed out after ${ms} ms`)), ms);
      const clear = (): void => {
        if (timer) {
          this.clearTimeout(timer);
        }
      };
      promise.then(
        () => {
          clear();
          resolve();
        },
        (e: unknown) => {
          clear();
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  /**
   * Synchronous teardown — no await, call the callback immediately (SIGKILL otherwise).
   *
   * @param callback function to invoke once teardown is complete
   */
  private onUnload(callback: () => void): void {
    try {
      if (this.notifyTimer) {
        this.clearInterval(this.notifyTimer);
        this.notifyTimer = undefined;
      }
      this.ssdp?.stop();
      void this.setState("info.connection", { val: false, ack: true });
      callback();
    } catch {
      callback();
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Fakeroku(options);
} else {
  // Start the instance directly
  (() => new Fakeroku())();
}
