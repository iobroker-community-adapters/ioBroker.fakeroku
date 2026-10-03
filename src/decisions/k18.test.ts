// Guard of K18 (krobi 2026-10-03, kept in its reduced form after F-00): the device info and the app list are answered —
// what a Harmony and a Sofabaton read. Sealed in the register — a change goes through the Werkbank.
import { createServer } from "node:net";
import { get } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EcpHttpServer } from "../ecp/ecp-http-server";

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

/**
 * One GET against the server.
 *
 * @param port the server port
 * @param path the path
 * @returns status and body
 */
function fetchText(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path }, res => {
      let body = "";
      res.on("data", chunk => (body += String(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });
}

describe("K18 — the device info and the app list are answered", () => {
  let server: EcpHttpServer;
  let port = 0;
  beforeAll(async () => {
    port = await freePort();
    server = new EcpHttpServer({
      device: { uuid: "guard0000000000000000000000k18", port },
      friendlyName: "Wohnzimmer",
      deviceType: "tv",
      bindIp: "127.0.0.1",
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
      onCommand: () => true,
      onFatalError: () => {},
      isClientAllowed: () => true,
    });
    await server.start();
  });
  afterAll(() => server.stop());

  it("answers /query/device-info with the device", async () => {
    const r = await fetchText(port, "/query/device-info");
    expect(r.status).toBe(200);
    expect(r.body).toContain("<device-info>");
    expect(r.body).toContain("<friendly-device-name>Wohnzimmer</friendly-device-name>");
  });

  it("answers /query/apps with the app list", async () => {
    const r = await fetchText(port, "/query/apps");
    expect(r.status).toBe(200);
    expect(r.body).toContain("<apps>");
    expect(r.body).toContain("<app ");
  });
});
