import * as http from "node:http";
import type { RokuAdvert } from "../discovery/ssdp-messages";
import type { SsdpLogger } from "../discovery/ssdp-responder";
import { type CommandEvent, parseEcpCommand } from "./ecp-command";
import { type AppEntry, buildAppsXml, buildDescXml, buildDeviceInfoXml } from "./device-info";
import { isLanClient } from "./lan-guard";

/** Configuration for one emulated Roku's ECP HTTP server. */
export interface EcpServerConfig {
  /** The emulated Roku (uuid + port). */
  device: RokuAdvert;
  /** Display name shown in the description / device-info. */
  friendlyName: string;
  /** Apps advertised at /query/apps. */
  apps: AppEntry[];
  /** Interface IP to bind to. */
  interfaceIp: string;
  /** Logger. */
  logger: SsdpLogger;
  /** Called for every accepted POST command. */
  onCommand: (cmd: CommandEvent) => void;
}

/**
 * The Roku ECP HTTP server for one emulated device. Serves the UPnP description,
 * /query/device-info (with a current version) and /query/apps; turns POST
 * key/launch/input/search into command events. Unknown GET paths get a clean 404
 * (not the old adapter's empty 200), and commands are accepted only from the LAN.
 */
export class EcpHttpServer {
  private server: http.Server | undefined;

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
      server.listen(this.config.device.port, this.config.interfaceIp, () => {
        server.removeListener("error", onError);
        server.on("error", (err: Error) => this.config.logger.error(`ECP server error: ${err.message}`));
        resolve();
      });
    });
    this.config.logger.debug(
      `ECP server "${this.config.friendlyName}" on ${this.config.interfaceIp}:${this.config.device.port}`,
    );
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!isLanClient(req.socket.remoteAddress)) {
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
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/xml; charset=utf-8");
      res.end(body);
      return;
    }

    if (method === "POST") {
      req.resume(); // drain any body
      const cmd = parseEcpCommand("POST", url);
      if (!cmd) {
        res.statusCode = 404;
        res.end();
        return;
      }
      try {
        this.config.onCommand(cmd);
      } catch (e) {
        this.config.logger.warn(`onCommand failed: ${e instanceof Error ? e.message : String(e)}`);
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
        return buildDescXml(this.config.device, this.config.friendlyName);
      case "/query/device-info":
        return buildDeviceInfoXml(this.config.device, this.config.friendlyName);
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
      } catch {
        // already closed
      }
      this.server = undefined;
    }
  }
}
