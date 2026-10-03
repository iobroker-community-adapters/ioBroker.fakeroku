// Guard of F-07 (krobi 2026-09-24 22:00): the app list stays fixed — fakeroku does not become a dynamic adapter with
// apps to set. Sealed in the register — a change goes through the Werkbank.
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { get } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_APPS } from "../ecp/device-info";
import { EcpHttpServer } from "../ecp/ecp-http-server";

const root = join(__dirname, "..", "..");

/**
 * A port nobody listens on.
 *
 * @returns the port
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

describe("F-07 — the app list is fixed and has no setting", () => {
  let server: EcpHttpServer;
  let port = 0;
  beforeAll(async () => {
    port = await freePort();
    server = new EcpHttpServer({
      device: { uuid: "guard0000000000000000000000f07", port },
      friendlyName: "Wohnzimmer",
      deviceType: "player",
      bindIp: "127.0.0.1",
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
      onCommand: () => true,
      onFatalError: () => {},
      isClientAllowed: () => true,
    });
    await server.start();
  });
  afterAll(() => server.stop());

  it("answers /query/apps with exactly the fixed list", async () => {
    const body = await new Promise<string>((resolve, reject) => {
      get({ host: "127.0.0.1", port, path: "/query/apps" }, res => {
        let text = "";
        res.on("data", chunk => (text += String(chunk)));
        res.on("end", () => resolve(text));
      }).on("error", reject);
    });
    const ids = [...body.matchAll(/<app id="([^"]+)">/g)].map(m => m[1]);
    expect(ids).toEqual(DEFAULT_APPS.map(app => app.id));
    expect(ids.length).toBeGreaterThan(0);
  });

  it("offers no setting for apps — neither in the instance settings nor in its defaults", () => {
    const io = JSON.parse(readFileSync(join(root, "io-package.json"), "utf8")) as { native: Record<string, unknown> };
    expect(Object.keys(io.native).sort()).toEqual(["bind", "devices"]);
    const form = readFileSync(join(root, "admin", "jsonConfig.json"), "utf8");
    expect(form).not.toMatch(/"apps"/i);
  });
});
