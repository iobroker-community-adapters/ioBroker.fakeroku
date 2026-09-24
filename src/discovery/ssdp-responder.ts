import * as dgram from "node:dgram";
import type { Membership } from "../lib/detect-ip";
import { errText } from "../lib/errors";
import { isLanClient } from "../lib/lan-guard";
import type { AdapterLogger } from "../lib/logger";
import {
  answersSearch,
  buildAliveNotify,
  buildByebyeNotify,
  buildSearchResponse,
  rokuSearchTarget,
  type RokuAdvert,
} from "./ssdp-messages";

const SSDP_PORT = 1900;
const MULTICAST_ADDR = "239.255.255.250";
/** How often at most a repeating socket problem (a failed answer, a receive error) is logged. */
const PROBLEM_LOG_INTERVAL_MS = 60_000;

/** Configuration for the Roku SSDP responder. */
export interface RokuSsdpResponderConfig {
  /** Emulated Rokus to answer for. */
  devices: RokuAdvert[];
  /**
   * The chosen interface address, or `undefined` for "all interfaces". With a chosen interface
   * the outgoing multicast (NOTIFY) is pinned to it and every answer carries it.
   */
  bindIp: string | undefined;
  /** Routable IP announced when nothing more specific is known — never `0.0.0.0`. */
  advertiseIp: string;
  /**
   * Interfaces to join the multicast group on — one entry per interface. With a chosen interface
   * this is just that one; in the auto case it is every real interface of the host, so a
   * multi-homed host hears M-SEARCH on all its LANs. Empty → OS default only.
   */
  membershipInterfaces: Membership[];
  /** Logger. */
  logger: AdapterLogger;
  /**
   * Whether a searching client may be answered (default: {@link isLanClient} against all the
   * host's networks). The adapter narrows it to the chosen interface's network.
   */
  isClientAllowed?: (address: string) => boolean;
  /**
   * The host's own address in the network of a searching client (auto case). An answer must carry
   * an address the asking remote can reach — on a host with several networks that is the address
   * of the network the search came from, not the one primary address. `undefined` → advertiseIp.
   */
  advertiseFor?: (remote: string) => string | undefined;
  /**
   * Called at most once if the socket closes AFTER a successful start without {@link stop} being
   * called — discovery is gone and the adapter should stop announcing into it.
   */
  onFatalError?: (err: Error) => void;
}

/** A socket that sends the NOTIFY/byebye of ONE interface, with that interface's address. */
interface Sender {
  /** The interface the sender belongs to. */
  iface: string;
  /** The interface address — the LOCATION its announcements carry. */
  address: string;
  /** The socket, bound to the address and pinned to the interface for multicast. */
  socket: dgram.Socket;
}

/**
 * Roku SSDP responder. Answers M-SEARCH(roku:ecp and relatives) with Roku's exact response format
 * (built by hand — node-ssdp appends a `::device` suffix to the USN that Roku never uses) and
 * announces ssdp:alive / ssdp:byebye.
 *
 * Receiving: one socket on 0.0.0.0:1900 (shared via `reuseAddr`), in the multicast group on every
 * interface of {@link RokuSsdpResponderConfig.membershipInterfaces} — one membership per interface.
 *
 * Sending: an answer goes back unicast to the searching remote and carries the address of the
 * network it came from. A NOTIFY in the auto case goes out once per interface, from a small
 * sender socket bound to that interface's address, so every LAN hears an address it can reach;
 * with a chosen interface it goes out of the receiving socket, pinned to that interface.
 *
 * Owns no timers: the adapter drives {@link announce} on a managed interval and bounds
 * {@link start} with a managed timeout.
 */
export class RokuSsdpResponder {
  private socket: dgram.Socket | undefined;
  private fatalReported = false;
  /** Set by {@link stop}: a close after that is ours, not a death to report. */
  private closing = false;
  /** Interfaces already in the group — a second join through another address throws EADDRINUSE. */
  private readonly joined = new Set<string>();
  /** The per-interface NOTIFY senders of the auto case. */
  private readonly senders = new Map<string, Sender>();
  /** When a repeating problem was last logged, per kind. */
  private readonly problemLoggedAt = new Map<string, number>();
  /**
   * The devices this responder answers for — its OWN list, not the caller's array. A device whose
   * port was busy at start-up joins when its retry succeeds, one whose server died leaves;
   * {@link addDevice} and {@link removeDevice} are the only ways in and out.
   */
  private readonly devices: RokuAdvert[];

  /**
   * @param config responder configuration
   */
  public constructor(private readonly config: RokuSsdpResponderConfig) {
    this.devices = [...config.devices];
  }

  /**
   * Announce one more device from now on — an emulated Roku that started late.
   *
   * @param device the advert to answer for
   */
  public addDevice(device: RokuAdvert): void {
    if (!this.devices.some(d => d.uuid === device.uuid)) {
      this.devices.push(device);
    }
  }

  /**
   * Stop answering for a device — its ECP server died.
   *
   * @param uuid the identity of the device to drop
   */
  public removeDevice(uuid: string): void {
    const at = this.devices.findIndex(d => d.uuid === uuid);
    if (at >= 0) {
      this.devices.splice(at, 1);
    }
  }

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
        // Pin OUTGOING multicast (NOTIFY) to the chosen interface. Binding the socket only sets
        // the source address; the multicast egress interface is IP_MULTICAST_IF (Node dgram
        // docs), so without this a NOTIFY can leave the wrong NIC on a multi-homed host.
        if (this.config.bindIp) {
          try {
            socket.setMulticastInterface(this.config.bindIp);
          } catch (e) {
            this.config.logger.warn(
              `SSDP: could not pin multicast egress to ${this.config.bindIp}: ${errText(e)} — NOTIFY may use the default interface`,
            );
          }
        }
        socket.on("error", (err: Error) => this.onSocketError(err));
        socket.on("close", () => this.onSocketClose());
        socket.on("message", (msg, rinfo) => this.onMessage(msg.toString("utf8"), rinfo.address, rinfo.port));
        resolve();
      });
    });
    if (!this.config.bindIp) {
      this.openSenders(this.config.membershipInterfaces);
    }

    const join = this.config.membershipInterfaces.length
      ? this.config.membershipInterfaces.map(m => `${m.iface} ${m.address}`).join(", ")
      : "default";
    this.config.logger.debug(
      `Roku SSDP responder on :${SSDP_PORT}, advertising ${this.config.advertiseIp} (join: ${join})`,
    );
  }

  /**
   * Follow the host while running — the automatic case only. The fallback address moves with a
   * DHCP change, and interfaces that came up since the start are joined and get their own NOTIFY
   * sender; one that went away loses its sender. An interface already in the group is not joined
   * again (EADDRINUSE on every pass otherwise).
   *
   * @param advertiseIp the routable IP to announce when nothing more specific is known
   * @param membershipInterfaces the interfaces the host has now
   * @returns true if the fallback address actually changed
   */
  public refreshAdvertise(advertiseIp: string, membershipInterfaces: Membership[]): boolean {
    const changed = advertiseIp !== this.config.advertiseIp;
    this.config.advertiseIp = advertiseIp;
    this.config.membershipInterfaces = [...membershipInterfaces];
    if (this.socket) {
      for (const m of membershipInterfaces) {
        if (!this.joined.has(m.iface)) {
          this.tryJoin(this.socket, m);
        }
      }
      if (!this.config.bindIp) {
        const present = new Set(membershipInterfaces.map(m => `${m.iface}|${m.address}`));
        for (const [key, sender] of this.senders) {
          if (!present.has(key)) {
            this.closeSender(key, sender);
          }
        }
        this.openSenders(membershipInterfaces);
      }
    }
    return changed;
  }

  /**
   * Join the multicast group on each selected interface, or on the OS default when none is known.
   *
   * @param socket the bound SSDP socket
   */
  private joinMulticast(socket: dgram.Socket): void {
    const ifaces = this.config.membershipInterfaces;
    if (ifaces.length === 0) {
      this.tryJoin(socket, undefined);
      return;
    }
    for (const m of ifaces) {
      if (!this.joined.has(m.iface)) {
        this.tryJoin(socket, m);
      }
    }
  }

  /**
   * Join the group on one interface; a failure warns but does not throw, so one bad interface
   * cannot stop the responder.
   *
   * @param socket the bound SSDP socket
   * @param m the interface to join on, or undefined for the OS default
   */
  private tryJoin(socket: dgram.Socket, m: Membership | undefined): void {
    try {
      socket.addMembership(MULTICAST_ADDR, m?.address);
      if (m) {
        this.joined.add(m.iface);
      }
    } catch (e) {
      // Usually an OS routing issue (the interface is not in the multicast table), or ENOBUFS on
      // a host past the kernel's limit of group memberships per socket. Don't die: a paired
      // controller still reaches the ECP port. Warn so the "no discovery" symptom is findable.
      this.config.logger.warn(
        `SSDP multicast join failed on ${m ? `${m.iface} (${m.address})` : "default interface"}: ${errText(e)} — discovery may be incomplete`,
      );
    }
  }

  /**
   * Open a NOTIFY sender for every interface that has none yet (auto case). A failed sender only
   * costs that interface its proactive announcement; answers to searches still reach it.
   *
   * @param memberships the interfaces to announce on
   */
  private openSenders(memberships: Membership[]): void {
    for (const m of memberships) {
      const key = `${m.iface}|${m.address}`;
      if (this.senders.has(key)) {
        continue;
      }
      try {
        const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
        socket.on("error", (err: Error) =>
          this.logProblem(`sender ${m.iface}`, `SSDP sender on ${m.iface}: ${errText(err)}`),
        );
        socket.bind({ address: m.address, port: 0 }, () => {
          try {
            socket.setMulticastInterface(m.address);
          } catch (e) {
            this.logProblem(
              `sender ${m.iface}`,
              `SSDP sender on ${m.iface} could not pin its interface: ${errText(e)}`,
            );
          }
        });
        this.senders.set(key, { iface: m.iface, address: m.address, socket });
      } catch (e) {
        this.logProblem(`sender ${m.iface}`, `SSDP sender on ${m.iface} could not open: ${errText(e)}`);
      }
    }
  }

  /**
   * Close one NOTIFY sender.
   *
   * @param key its map key
   * @param sender the sender
   */
  private closeSender(key: string, sender: Sender): void {
    try {
      sender.socket.close();
    } catch {
      // already closed
    }
    this.senders.delete(key);
  }

  /**
   * An error on the receiving socket after a good start. On Linux/macOS this is a receive error
   * (`recvmsg`, e.g. ENOBUFS under memory pressure): Node reports it, and the socket keeps
   * receiving. Closing it here would turn a passing hiccup into discovery that stays off until a
   * restart — so it is logged (throttled) and the socket stays.
   *
   * @param err the socket error
   */
  private onSocketError(err: Error): void {
    this.logProblem("socket", `SSDP socket error: ${errText(err)}`);
  }

  /** The receiving socket closed. If {@link stop} did not close it, discovery is gone — report once. */
  private onSocketClose(): void {
    if (this.closing) {
      return;
    }
    this.socket = undefined;
    const notify = this.config.onFatalError;
    if (notify && !this.fatalReported) {
      this.fatalReported = true;
      notify(new Error("SSDP socket closed"));
    }
  }

  /**
   * Log a problem that can repeat — at most once per minute and kind, so a remote that keeps
   * searching from an unreachable address cannot fill the log.
   *
   * @param kind what the problem is about
   * @param line the log line
   */
  private logProblem(kind: string, line: string): void {
    const now = Date.now();
    if (now - (this.problemLoggedAt.get(kind) ?? 0) >= PROBLEM_LOG_INTERVAL_MS) {
      this.problemLoggedAt.set(kind, now);
      this.config.logger.warn(line);
    }
  }

  private onMessage(text: string, address: string, port: number): void {
    const target = rokuSearchTarget(text);
    if (!target) {
      return;
    }
    // Port 1900 is bound on every interface. A search from outside the adapter's networks gets
    // no answer: the ECP server would refuse that client anyway, and replying to a spoofed
    // source would make the emulator a small reflection amplifier.
    const allowed = this.config.isClientAllowed ?? ((a: string): boolean => isLanClient(a));
    if (!allowed(address)) {
      this.config.logger.debug(`SSDP search from ${address} ignored — not in the adapter's networks`);
      return;
    }
    const location = this.config.bindIp ?? this.config.advertiseFor?.(address) ?? this.config.advertiseIp;
    for (const device of this.devices.filter(d => answersSearch(d, target))) {
      const response = Buffer.from(buildSearchResponse(device, location, target));
      this.socket?.send(response, port, address, err => {
        if (err) {
          this.logProblem("answer", `SSDP response send failed: ${errText(err)}`);
        }
      });
    }
  }

  /** The sockets and addresses an announcement goes out through: one per interface, or the receiver. */
  private announcers(): { socket: dgram.Socket; address: string }[] {
    if (this.senders.size > 0) {
      return [...this.senders.values()].map(s => ({ socket: s.socket, address: s.address }));
    }
    return this.socket ? [{ socket: this.socket, address: this.config.advertiseIp }] : [];
  }

  /** Send one proactive ssdp:alive burst for every device. The adapter calls this on a managed interval. */
  public announce(): void {
    if (!this.socket) {
      return;
    }
    for (const { socket, address } of this.announcers()) {
      for (const device of this.devices) {
        try {
          socket.send(Buffer.from(buildAliveNotify(device, address)), SSDP_PORT, MULTICAST_ADDR, err => {
            if (err) {
              this.config.logger.debug(`SSDP NOTIFY send failed: ${errText(err)}`);
            }
          });
        } catch (e) {
          this.config.logger.debug(`SSDP NOTIFY send failed: ${errText(e)}`);
        }
      }
    }
  }

  /**
   * Say goodbye for every device and resolve once the datagrams are out. Without this a
   * controller that keeps its list from discovery keeps the emulated Roku for the announced
   * max-age. It always resolves: a `dgram` send reports back through its callback either way, and
   * a synchronous throw is caught. The host's `stopTimeout` bounds teardown as a whole.
   *
   * The sockets stay open until {@link stop} — sending into a closed one would throw.
   *
   * @returns a promise that always resolves
   */
  public byebye(): Promise<void> {
    const outs = this.socket ? this.announcers() : [];
    if (outs.length === 0 || this.devices.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      let open = outs.length * this.devices.length;
      const done = (): void => {
        if (--open === 0) {
          resolve();
        }
      };
      for (const { socket } of outs) {
        for (const device of this.devices) {
          try {
            socket.send(Buffer.from(buildByebyeNotify(device)), SSDP_PORT, MULTICAST_ADDR, err => {
              if (err) {
                this.config.logger.debug(`SSDP byebye send failed: ${errText(err)}`);
              }
              done();
            });
          } catch (e) {
            this.config.logger.debug(`SSDP byebye send failed: ${errText(e)}`);
            done();
          }
        }
      }
    });
  }

  /** Synchronous close — safe to call from onUnload. Closing the socket drops its memberships. */
  public stop(): void {
    this.closing = true;
    for (const [key, sender] of this.senders) {
      this.closeSender(key, sender);
    }
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
