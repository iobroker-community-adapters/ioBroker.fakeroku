import * as http from "node:http";
import type { RokuAdvert } from "../discovery/ssdp-messages";
import { errText } from "../lib/errors";
import { isLanClient } from "../lib/lan-guard";
import type { AdapterLogger } from "../lib/logger";
import { type CommandEvent, parseEcpCommand } from "./ecp-command";
import { type AppEntry, buildAppsXml, buildDescXml, buildDeviceInfoXml } from "./device-info";
import type { DeviceType } from "./state-model";

/** Configuration for one emulated Roku's ECP HTTP server. */
export interface EcpServerConfig {
  /** The emulated Roku (uuid + port). */
  device: RokuAdvert;
  /** Display name shown in the description / device-info. */
  friendlyName: string;
  /** Apps advertised at /query/apps. */
  apps: AppEntry[];
  /** The emulated device type (player / tv) — drives the device-info response. */
  deviceType: DeviceType;
  /** Interface IP to bind the HTTP server to, or `undefined` to bind all interfaces (auto). */
  bindIp: string | undefined;
  /** Logger. */
  logger: AdapterLogger;
  /**
   * Called for every parsed POST command. Returns whether the command was actually
   * applied — a `false` means the adapter's rate gate dropped it, and the server
   * then keeps quiet about it too (see {@link EcpHttpServer.handle}).
   */
  onCommand: (cmd: CommandEvent) => boolean;
  /**
   * Called at most once if the server dies AFTER a successful start — a runtime
   * error it cannot recover from. Without it the adapter would keep reporting a
   * connected instance while this emulated Roku no longer answers anything, and
   * `info.connection` means "EVERY configured Roku is listening". Mirrors the SSDP
   * responder, which has carried this callback since 1.1.0.
   */
  onFatalError?: (err: Error) => void;
}

/**
 * Longest command detail written to the log. The text comes from the request URL,
 * which a LAN client controls up to Node's header limit (16 KiB) — the `command`
 * state is capped at 500 characters for exactly that reason, and the log line
 * beside it must not be the way around the cap.
 */
const MAX_LOGGED_DETAIL = 120;

/** How often at most the "rejected a non-LAN request" line is written. */
const NON_LAN_LOG_INTERVAL_MS = 60_000;

/**
 * The Roku ECP HTTP server for one emulated device. Serves the UPnP description,
 * /query/device-info (with a current version) and /query/apps; turns POST
 * key/launch/input/search into command events. Unknown GET paths get a clean 404
 * (not the old adapter's empty 200), and commands are accepted only from the LAN.
 */
export class EcpHttpServer {
  private server: http.Server | undefined;
  /** When the non-LAN rejection was last logged — a scanner must not fill the log. */
  private nonLanLoggedAt = 0;
  /** Whether the fatal-error callback has already fired — it reports once, not per event. */
  private fatalReported = false;

  /**
   * @param config server configuration
   */
  public constructor(private readonly config: EcpServerConfig) {}

  /** Bind the HTTP server to the interface + port. Rejects on bind error. */
  public async start(): Promise<void> {
    const server = http.createServer((req, res) => this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      server.once("error", onError);
      server.listen(this.config.device.port, this.config.bindIp, () => {
        server.removeListener("error", onError);
        server.on("error", (err: Error) => this.onRuntimeError(err));
        resolve();
      });
    });
    this.config.logger.debug(
      `ECP server "${this.config.friendlyName}" on ${this.config.bindIp ?? "0.0.0.0"}:${this.config.device.port}`,
    );
  }

  /**
   * A server error after a good start — this emulated Roku is gone. Report it once
   * so the adapter can revise `info.connection` instead of showing a healthy
   * instance whose device answers nothing; the other devices keep running.
   *
   * @param err the server error
   */
  private onRuntimeError(err: Error): void {
    this.config.logger.error(`ECP server "${this.config.friendlyName}" error: ${err.message}`);
    const notify = this.config.onFatalError;
    if (notify && !this.fatalReported) {
      this.fatalReported = true;
      notify(err);
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const peer = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "") || "?";
    if (!isLanClient(req.socket.remoteAddress)) {
      // Debug (not warn): a stray WAN scanner must not spam the log, but when a
      // remote sits on the wrong subnet/VLAN this is the only trace of "why rejected".
      // Throttled: a scanner sends thousands of requests, and every one of them
      // would otherwise cost a log line — the very flood the rate gate exists for.
      const now = Date.now();
      if (now - this.nonLanLoggedAt >= NON_LAN_LOG_INTERVAL_MS) {
        this.nonLanLoggedAt = now;
        this.config.logger.debug(`ECP request from non-LAN ${peer} rejected (403)`);
      }
      res.statusCode = 403;
      res.end();
      return;
    }
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    if (method === "GET") {
      const body = this.routeGet(url);
      if (body === null) {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (url.split("?")[0] === "/query/device-info") {
        // The pairing probe — the first thing a remote asks and the usual failure
        // point (a Sofabaton rejects a too-old version). Visible for diagnosis.
        this.config.logger.debug(`device-info queried from ${peer} (remote pairing/probe)`);
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/xml; charset=utf-8");
      res.end(body);
      return;
    }

    if (method === "POST") {
      // The body is never read: Node discards an unconsumed body when the response
      // finishes, so the keep-alive connection stays usable (guarded by a test).
      const cmd = parseEcpCommand("POST", url);
      if (!cmd) {
        res.statusCode = 404;
        res.end();
        return;
      }
      // Apply FIRST, log second. The adapter's rate gate sits inside onCommand, so
      // logging before it would leave the log wide open for exactly the flood the
      // gate exists to stop: a device sending a thousand presses a second would
      // write a thousand lines while only 25 reach the states database.
      let accepted = false;
      try {
        accepted = this.config.onCommand(cmd);
      } catch (e) {
        this.config.logger.warn(`onCommand failed: ${errText(e)}`);
      }
      if (accepted) {
        // The received command — without this a keypress leaves no trace at all, so a
        // "I press a button and nothing happens" report has nothing to go on.
        // Control characters (a decoded `Lit_%0A`) are replaced so one request stays one
        // log line, and the text is capped like the state value it accompanies.
        const detail = (cmd.key ?? cmd.appId ?? cmd.text ?? "").replace(/\p{Cc}/gu, "?").slice(0, MAX_LOGGED_DETAIL);
        this.config.logger.debug(`ECP ${cmd.type}${detail ? ` ${detail}` : ""} from ${peer}`);
      }
      res.statusCode = 200;
      res.end();
      return;
    }

    res.statusCode = 405;
    res.end();
  }

  private routeGet(url: string): string | null {
    switch (url.split("?")[0]) {
      case "/":
        return buildDescXml(this.config.device, this.config.friendlyName, this.config.deviceType);
      case "/query/device-info":
        return buildDeviceInfoXml(this.config.device, this.config.friendlyName, this.config.deviceType);
      case "/query/apps":
        return buildAppsXml(this.config.apps);
      default:
        return null;
    }
  }

  /** Synchronous close — safe from onUnload. */
  public stop(): void {
    if (this.server) {
      try {
        this.server.close();
        // close() only stops accepting new sockets; established keep-alive
        // connections (a controller holding one) keep the event loop busy and can
        // drag the synchronous onUnload toward a SIGKILL. Force them shut (Node >= 22).
        this.server.closeAllConnections();
      } catch {
        // already closed
      }
      this.server = undefined;
    }
  }
}
