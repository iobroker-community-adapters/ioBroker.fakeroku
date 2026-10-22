import type { RokuAdvert } from "./ssdp-messages";
import type { RokuSsdpResponder, RokuSsdpResponderConfig } from "./ssdp-responder";
import { RETRY_NOTE } from "../lib/constants";
import { detectLocalIPv4s, detectPrimaryIPv4, localAddressFor } from "../lib/detect-ip";
import { errText } from "../lib/err-text";
import { localNets } from "../lib/network-address";

/** Managed timeout for a stuck SSDP start (a busy port 1900 must not hang onReady). */
const SSDP_START_TIMEOUT_MS = 5000;
/** Proactive ssdp:alive interval so controllers find the device without searching. */
const SSDP_NOTIFY_INTERVAL_MS = 300_000;

/**
 * What discovery uses of the adapter: its log and its managed timers. The timers are properties with a function type,
 * not method signatures — the repochecker reads a timer method signature as a plain timer call (S5005).
 */
export interface DiscoveryAdapter {
  /** The adapter log. */
  readonly log: ioBroker.Logger;
  /** The adapter's managed setTimeout — undefined while the adapter shuts down. */
  setTimeout: (callback: () => void, ms: number) => ioBroker.Timeout | undefined;
  /** The adapter's managed clearTimeout. */
  clearTimeout: (timer: ioBroker.Timeout) => void;
  /** The adapter's managed setInterval — undefined while the adapter shuts down. */
  setInterval: (callback: () => void, ms: number) => ioBroker.Interval | undefined;
  /** The adapter's managed clearInterval. */
  clearInterval: (timer: ioBroker.Interval) => void;
}

/** What discovery asks the adapter at the moment it needs it — never a copy taken earlier. */
export interface DiscoveryHooks {
  /** The chosen interface's address, or undefined for "all". */
  bindIp: () => string | undefined;
  /** The adverts of the Rokus that listen right now. */
  running: () => RokuAdvert[];
  /** The trust boundary: may this client be answered? */
  isClientAllowed: (address: string | undefined) => boolean;
  /** The host said stop. */
  stopping: () => boolean;
  /** Build the responder — the adapter's construction seam, resolved on every start. */
  makeSsdpResponder: (options: RokuSsdpResponderConfig) => RokuSsdpResponder;
  /** Discovery died at runtime: retry it and show the yellow status. */
  onDown: () => void;
}

/**
 * The discovery lifecycle of the emulated Rokus: the SSDP responder, its announce timer, its start with a bound, its
 * outage and its return, and the farewell.
 */
export class DiscoveryLifecycle {
  private ssdp: RokuSsdpResponder | undefined;
  private notifyTimer: ioBroker.Interval | undefined;
  /** Discovery is answering and announcing — one of the conditions of a healthy instance. */
  private discoveryUp = false;
  /** Discovery is down and the warning about it is written: repeats go to debug, its return to info. */
  private discoveryDown = false;

  /**
   * @param adapter the adapter's log and managed timers
   * @param hooks what discovery asks the adapter when it needs it
   */
  public constructor(
    private readonly adapter: DiscoveryAdapter,
    private readonly hooks: DiscoveryHooks,
  ) {}

  /**
   * Discovery answers and announces.
   *
   * @returns whether it is up
   */
  public get up(): boolean {
    return this.discoveryUp;
  }

  /**
   * A responder exists — started, or starting. While none does, the retry starts discovery again.
   *
   * @returns whether one exists
   */
  public get started(): boolean {
    return this.ssdp !== undefined;
  }

  /**
   * Answer and announce for one more Roku that listens now.
   *
   * @param advert its identity and port
   */
  public addDevice(advert: RokuAdvert): void {
    this.ssdp?.addDevice(advert);
  }

  /**
   * Stop pointing remotes at a Roku that does not listen any more.
   *
   * @param uuid its identity
   */
  public removeDevice(uuid: string): void {
    this.ssdp?.removeDevice(uuid);
  }

  /**
   * Start the SSDP responder for the devices that are listening.
   *
   * Discovery is what lets a remote FIND an emulated Roku; a remote already paired keeps working without it. A busy port
   * 1900, a stuck bind or a host without an IPv4 therefore leaves the Rokus running and the instance yellow, and the
   * minute retry starts it again. In the auto case join every interface and answer each network with the host's own
   * address in it, so a multi-homed host is discoverable — and reachable — on all its LANs; a chosen interface pins
   * membership, NOTIFY egress and every answer to itself.
   */
  public async startDiscovery(): Promise<void> {
    // Both callers start it only while nothing runs and the host has not said stop.
    const bindIp = this.hooks.bindIp();
    const advertiseIp = bindIp ?? detectPrimaryIPv4();
    if (!advertiseIp) {
      this.discoveryFailed("the host has no IPv4 address");
      return;
    }
    const membershipInterfaces = bindIp
      ? [{ iface: localNets().find(net => net.address === bindIp)?.iface ?? bindIp, address: bindIp }]
      : detectLocalIPv4s();
    const ssdp = this.hooks.makeSsdpResponder({
      devices: [...this.hooks.running()],
      bindIp,
      advertiseIp,
      membershipInterfaces,
      logger: this.adapter.log,
      isClientAllowed: this.hooks.isClientAllowed,
      // "All interfaces": every search is answered with the host's address in the searcher's own
      // network. A chosen interface answers with its address only (the responder uses bindIp).
      advertiseFor: bindIp ? undefined : remote => localAddressFor(remote),
      onFatalError: err => this.onSsdpFatal(err),
    });
    this.ssdp = ssdp;
    try {
      await this.startWithTimeout(ssdp.start(), SSDP_START_TIMEOUT_MS);
    } catch (e) {
      // A start that only timed out can still bind later. Close it, or the socket
      // outlives the reference dropped here and keeps answering with nobody to stop it.
      ssdp.stop();
      if (this.ssdp === ssdp) {
        this.ssdp = undefined;
      }
      this.discoveryFailed(errText(e));
      return;
    }
    // The bind resolved after the host asked us to stop: announcing now would put a
    // device back into the network we just said goodbye to, and the adapter's setInterval would
    // refuse with "setInterval called, but adapter is shutting down".
    if (this.hooks.stopping()) {
      ssdp.stop();
      return;
    }
    this.discoveryUp = true;
    if (this.discoveryDown) {
      this.discoveryDown = false;
      this.adapter.log.info("SSDP discovery is running again — remotes can find the emulated Rokus.");
    }
    ssdp.announce();
    const timer = this.adapter.setInterval(() => this.announceTick(), SSDP_NOTIFY_INTERVAL_MS);
    if (timer) {
      this.notifyTimer = timer;
    }
  }

  /**
   * Discovery is down: one warning with the cause for the outage, its repeats on debug.
   *
   * @param cause why it is down
   */
  private discoveryFailed(cause: string): void {
    this.discoveryUp = false;
    if (this.discoveryDown) {
      this.adapter.log.debug(`SSDP discovery still unavailable: ${cause}`);
      return;
    }
    this.discoveryDown = true;
    this.adapter.log.warn(
      `SSDP discovery unavailable: ${cause} — paired remotes keep working, a new pairing does not; ${RETRY_NOTE}`,
    );
  }

  /**
   * One NOTIFY pass: follow the host first, then announce.
   *
   * Only in the automatic case — a chosen interface is the user's decision and does not move under
   * us. Every pass hands the responder the interfaces the host has NOW: one that came up since the
   * start (a second network card, a VLAN) is joined and announced on, one that went away is
   * dropped, and a changed fallback address (a DHCP lease change) is logged once. Every five
   * minutes is early enough: a controller caches the announced address for its max-age of an hour.
   */
  private announceTick(): void {
    if (!this.hooks.bindIp()) {
      const current = detectPrimaryIPv4();
      if (current && this.ssdp?.refreshAdvertise(current, detectLocalIPv4s())) {
        this.adapter.log.info(`Host address changed — the emulated Rokus are now advertised on ${current}.`);
      }
    }
    this.ssdp?.announce();
  }

  /**
   * The SSDP responder died at runtime (its socket closed after a good start). Stop announcing into the dead socket,
   * close what is left of it, and let the minute retry start discovery again; the ECP servers keep working, the
   * instance is yellow meanwhile.
   *
   * @param err why it died
   */
  private onSsdpFatal(err: Error): void {
    this.stopAnnouncing();
    this.stop();
    if (this.hooks.stopping()) {
      return;
    }
    this.discoveryFailed(errText(err));
    this.hooks.onDown();
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
      const timer = this.adapter.setTimeout(() => reject(new Error(`SSDP start timed out after ${ms} ms`)), ms);
      const clear = (): void => {
        if (timer) {
          this.adapter.clearTimeout(timer);
        }
      };
      promise.then(
        () => {
          clear();
          resolve();
        },
        (e: unknown) => {
          clear();
          // Lint (prefer-promise-reject-errors) wants an Error here; errText downstream
          // would cope with anything, so this is the rule's shape, not a second safeguard.
          reject(e instanceof Error ? e : new Error(errText(e)));
        },
      );
    });
  }

  /** Stop announcing — the first step of teardown; the socket stays open for the farewell. */
  public stopAnnouncing(): void {
    if (this.notifyTimer) {
      this.adapter.clearInterval(this.notifyTimer);
      this.notifyTimer = undefined;
    }
  }

  /**
   * Say goodbye for every Roku, so a controller that keeps its list from discovery drops them now instead of after
   * the announced max-age.
   *
   * @returns a promise that always resolves — at once when there is no responder
   */
  public byebye(): Promise<void> {
    return this.ssdp ? this.ssdp.byebye() : Promise.resolve();
  }

  /** Close the responder — after the farewell, or when it died. */
  public stop(): void {
    this.ssdp?.stop();
    this.ssdp = undefined;
  }
}
