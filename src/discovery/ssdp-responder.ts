import * as dgram from "node:dgram";
import { buildAliveNotify, buildSearchResponse, matchesRokuSearch, type RokuAdvert } from "./ssdp-messages";

const SSDP_PORT = 1900;
const MULTICAST_ADDR = "239.255.255.250";

/** Minimal logger shape the responder needs (the adapter's `this.log` satisfies it). */
export type SsdpLogger = Pick<ioBroker.Log, "debug" | "warn" | "error">;

/** Configuration for the Roku SSDP responder. */
export interface RokuSsdpResponderConfig {
  /** Emulated Rokus to answer for. */
  devices: RokuAdvert[];
  /** Selected network-interface IP to bind the multicast join to and advertise. */
  interfaceIp: string;
  /** Logger. */
  logger: SsdpLogger;
}

/**
 * Interface-bound Roku SSDP responder. Answers M-SEARCH(roku:ecp) with Roku's
 * exact response format (built by hand — node-ssdp appends a `::device` suffix
 * to the USN that Roku never uses) and can proactively announce ssdp:alive.
 *
 * The multicast group is joined on the SELECTED interface, not the OS default —
 * the old adapter joined `0.0.0.0`, which on multi-homed hosts (e.g. a box bound
 * to 10.47.88.2) can attach to the wrong network and make discovery fail silently.
 *
 * Owns no timers: the adapter drives {@link announce} on a managed interval and
 * bounds {@link start} with a managed timeout.
 */
export class RokuSsdpResponder {
  private socket: dgram.Socket | undefined;

  /**
   * @param config responder configuration
   */
  public constructor(private readonly config: RokuSsdpResponderConfig) {}

  /** Bind on 1900, join multicast on the selected interface, start answering. Rejects on bind error. */
  public async start(): Promise<void> {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const onBindError = (err: Error): void => reject(err);
      socket.once("error", onBindError);
      socket.bind(SSDP_PORT, () => {
        socket.removeListener("error", onBindError);
        try {
          socket.addMembership(MULTICAST_ADDR, this.config.interfaceIp);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        socket.on("error", (err: Error) => {
          this.config.logger.error(`SSDP socket error: ${err.message}`);
          this.stop();
        });
        socket.on("message", (msg, rinfo) => this.onMessage(msg.toString("utf8"), rinfo.address, rinfo.port));
        resolve();
      });
    });

    this.config.logger.debug(`Roku SSDP responder bound on ${this.config.interfaceIp}:${SSDP_PORT}`);
  }

  private onMessage(text: string, address: string, port: number): void {
    if (!matchesRokuSearch(text)) {
      return;
    }
    for (const device of this.config.devices) {
      const response = Buffer.from(buildSearchResponse(device, this.config.interfaceIp));
      this.socket?.send(response, port, address, err => {
        if (err) {
          this.config.logger.warn(`SSDP response send failed: ${err.message}`);
        }
      });
    }
  }

  /** Send one proactive ssdp:alive burst for every device. The adapter calls this on a managed interval. */
  public announce(): void {
    if (!this.socket) {
      return;
    }
    for (const device of this.config.devices) {
      const notify = Buffer.from(buildAliveNotify(device, this.config.interfaceIp));
      this.socket.send(notify, SSDP_PORT, MULTICAST_ADDR, err => {
        if (err) {
          this.config.logger.debug(`SSDP NOTIFY send failed: ${err.message}`);
        }
      });
    }
  }

  /** Synchronous close — safe to call from onUnload. */
  public stop(): void {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // socket already closed
      }
      this.socket = undefined;
    }
  }
}
