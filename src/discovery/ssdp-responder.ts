import * as dgram from "node:dgram";
import type { AdapterLogger } from "../lib/logger";
import { buildAliveNotify, buildSearchResponse, matchesRokuSearch, type RokuAdvert } from "./ssdp-messages";

const SSDP_PORT = 1900;
const MULTICAST_ADDR = "239.255.255.250";

/** Configuration for the Roku SSDP responder. */
export interface RokuSsdpResponderConfig {
  /** Emulated Rokus to answer for. */
  devices: RokuAdvert[];
  /**
   * Interface IP the outgoing multicast (NOTIFY) is pinned to, or `undefined` to
   * let the OS default route decide (the auto case). A concrete value is only
   * needed on multi-homed hosts — see the class doc.
   */
  bindIp: string | undefined;
  /** Routable IP announced in the SSDP LOCATION so the controller reaches the ECP server — never `0.0.0.0`. */
  advertiseIp: string;
  /**
   * Interface IPs to join the multicast group on. With a concrete interface
   * selected this is just that one; in the auto case it is every routable IPv4
   * the host has, so a multi-homed host hears M-SEARCH on all its LANs (like the
   * emulator siblings, which listen on every interface). Empty → OS default only.
   */
  membershipInterfaces: string[];
  /** Logger. */
  logger: AdapterLogger;
  /**
   * Called at most once if the socket dies AFTER a successful start — a runtime
   * error the responder cannot recover from. Lets the adapter stop announcing
   * into a dead socket instead of showing a healthy instance with dead discovery.
   */
  onFatalError?: (err: Error) => void;
}

/**
 * Roku SSDP responder. Answers M-SEARCH(roku:ecp) with Roku's exact response
 * format (built by hand — node-ssdp appends a `::device` suffix to the USN that
 * Roku never uses) and can proactively announce ssdp:alive.
 *
 * The multicast group is joined on {@link RokuSsdpResponderConfig.membershipInterfaces}
 * — every routable interface in the auto case, or the single selected one. The
 * outgoing NOTIFY is pinned to {@link RokuSsdpResponderConfig.bindIp} when a
 * concrete interface is chosen (binding sets only the source address, not the
 * multicast egress interface); in the auto case the OS default route is used, which
 * is the honest choice when the user has not selected an interface. The LOCATION
 * always carries the routable {@link RokuSsdpResponderConfig.advertiseIp}.
 *
 * Owns no timers: the adapter drives {@link announce} on a managed interval and
 * bounds {@link start} with a managed timeout.
 */
export class RokuSsdpResponder {
  private socket: dgram.Socket | undefined;
  private fatalReported = false;

  /**
   * @param config responder configuration
   */
  public constructor(private readonly config: RokuSsdpResponderConfig) {}

  /** Bind on 1900, join multicast on the selected interface(s), start answering. Rejects on bind error. */
  public async start(): Promise<void> {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const onBindError = (err: Error): void => reject(err);
      socket.once("error", onBindError);
      socket.bind(SSDP_PORT, () => {
        socket.removeListener("error", onBindError);
        this.joinMulticast(socket);
        // Pin OUTGOING multicast (NOTIFY) to the chosen interface. Binding the socket
        // only sets the source address; the multicast egress interface is IP_MULTICAST_IF
        // (Node dgram docs), so without this a proactive NOTIFY can leave the wrong NIC on
        // a multi-homed host despite an explicit selection. Only when a concrete interface
        // is chosen — in the auto case the OS default route is the honest choice.
        if (this.config.bindIp) {
          try {
            socket.setMulticastInterface(this.config.bindIp);
          } catch (e) {
            this.config.logger.warn(
              `SSDP: could not pin multicast egress to ${this.config.bindIp}: ${errMsg(e)} — NOTIFY may use the default interface`,
            );
          }
        }
        socket.on("error", (err: Error) => this.onSocketError(err));
        socket.on("message", (msg, rinfo) => this.onMessage(msg.toString("utf8"), rinfo.address, rinfo.port));
        resolve();
      });
    });

    const join = this.config.membershipInterfaces.length ? this.config.membershipInterfaces.join(", ") : "default";
    this.config.logger.debug(
      `Roku SSDP responder on :${SSDP_PORT}, advertising ${this.config.advertiseIp} (join: ${join})`,
    );
  }

  /**
   * Join the multicast group on each selected interface, or on the OS default when
   * none is known.
   *
   * @param socket the bound SSDP socket
   */
  private joinMulticast(socket: dgram.Socket): void {
    const ifaces = this.config.membershipInterfaces;
    if (ifaces.length === 0) {
      this.tryJoin(socket, undefined);
      return;
    }
    for (const ip of ifaces) {
      this.tryJoin(socket, ip);
    }
  }

  /**
   * Join the group on one interface; a failure warns but does not throw, so one bad
   * interface cannot stop the responder.
   *
   * @param socket the bound SSDP socket
   * @param iface the interface IP to join on, or undefined for the OS default
   */
  private tryJoin(socket: dgram.Socket, iface: string | undefined): void {
    try {
      socket.addMembership(MULTICAST_ADDR, iface);
    } catch (e) {
      // A join failure is usually an OS routing issue (the chosen interface is not
      // in the multicast table). Don't die: a paired controller still reaches the
      // ECP port by the advertised IP, and NOTIFY may still leave via the default
      // route. Warn so the "no discovery" symptom is findable.
      this.config.logger.warn(
        `SSDP multicast join failed on ${iface ?? "default interface"}: ${errMsg(e)} — discovery may be incomplete`,
      );
    }
  }

  /**
   * A socket error after a good start — discovery is dead. Close the socket and tell
   * the adapter once so it can stop announcing and revise its connection state.
   *
   * @param err the socket error
   */
  private onSocketError(err: Error): void {
    this.config.logger.error(`SSDP socket error: ${err.message}`);
    const notify = this.config.onFatalError;
    this.stop();
    if (notify && !this.fatalReported) {
      this.fatalReported = true;
      notify(err);
    }
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

  /** Synchronous close — safe to call from onUnload. Closing the socket drops its memberships. */
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

/**
 * Message of an unknown thrown value.
 *
 * @param e the caught value
 * @returns its message or a string form
 */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
