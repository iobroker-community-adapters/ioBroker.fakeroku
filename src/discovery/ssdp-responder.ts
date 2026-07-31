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
  /**
   * Interface IP to join the multicast group on, or `undefined` to let the OS
   * pick its default interface (the auto case). A concrete value is only needed
   * on multi-homed hosts — see the class doc.
   */
  bindIp: string | undefined;
  /** Routable IP announced in the SSDP LOCATION so the controller reaches the ECP server — never `0.0.0.0`. */
  advertiseIp: string;
  /** Logger. */
  logger: SsdpLogger;
}

/**
 * Roku SSDP responder. Answers M-SEARCH(roku:ecp) with Roku's exact response
 * format (built by hand — node-ssdp appends a `::device` suffix to the USN that
 * Roku never uses) and can proactively announce ssdp:alive.
 *
 * The multicast group is joined on {@link RokuSsdpResponderConfig.bindIp} when a
 * concrete interface is selected, or on the OS default when it is `undefined`.
 * Explicit selection exists because on a multi-homed host the OS default can
 * attach to the wrong network and make discovery fail silently — but on the
 * common single-LAN host the default just works, so the adapter runs with no
 * configuration. The LOCATION always carries the routable
 * {@link RokuSsdpResponderConfig.advertiseIp}, never the bind wildcard.
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
          socket.addMembership(MULTICAST_ADDR, this.config.bindIp);
        } catch (e) {
          // A join failure is usually an OS routing issue (the chosen interface
          // is not in the multicast table). Don't die: a paired controller still
          // reaches the ECP port by the advertised IP, and NOTIFY may still leave
          // via the default route. Warn so the "no discovery" symptom is findable.
          const where = this.config.bindIp ?? "default interface";
          this.config.logger.warn(
            `SSDP multicast join failed on ${where}: ${e instanceof Error ? e.message : String(e)} — discovery may be incomplete`,
          );
        }
        socket.on("error", (err: Error) => {
          this.config.logger.error(`SSDP socket error: ${err.message}`);
          this.stop();
        });
        socket.on("message", (msg, rinfo) => this.onMessage(msg.toString("utf8"), rinfo.address, rinfo.port));
        resolve();
      });
    });

    this.config.logger.debug(
      `Roku SSDP responder on :${SSDP_PORT}, advertising ${this.config.advertiseIp} (join: ${this.config.bindIp ?? "default"})`,
    );
  }

  private onMessage(text: string, address: string, port: number): void {
    if (!matchesRokuSearch(text)) {
      return;
    }
    for (const device of this.config.devices) {
      const response = Buffer.from(buildSearchResponse(device, this.config.advertiseIp));
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
      const notify = Buffer.from(buildAliveNotify(device, this.config.advertiseIp));
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
