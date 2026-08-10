import * as http from "node:http";
import type { CommandEvent } from "./ecp-command";
import { EcpHttpServer } from "./ecp-http-server";

const PORT = 18099;
const debugLogs: string[] = [];
const noopLog = {
  debug: (m: string): void => {
    debugLogs.push(m);
  },
  warn: (): void => {},
  error: (): void => {},
};

function request(method: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method, path }, res => {
      let body = "";
      res.on("data", c => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("EcpHttpServer", () => {
  const commands: CommandEvent[] = [];
  let server: EcpHttpServer;

  beforeAll(async () => {
    server = new EcpHttpServer({
      device: { uuid: "abc123", port: PORT },
      friendlyName: "Test Roku",
      apps: [{ id: "12", name: "Netflix" }],
      deviceType: "player",
      bindIp: "127.0.0.1",
      logger: noopLog,
      onCommand: c => commands.push(c),
    });
    await server.start();
  });
  afterAll(() => server.stop());

  it("serves device-info with a current version", async () => {
    const r = await request("GET", "/query/device-info");
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/<software-version>1[4-9]\./);
  });
  it("serves the UPnP root description", async () => {
    const r = await request("GET", "/");
    expect(r.status).toBe(200);
    expect(r.body).toContain("urn:roku-com:device:player:1-0");
  });
  it("404s an unknown GET (not the old empty 200)", async () => {
    const r = await request("GET", "/query/does-not-exist");
    expect(r.status).toBe(404);
  });
  it("routes a keypress to onCommand and answers 200", async () => {
    commands.length = 0;
    const r = await request("POST", "/keypress/Home");
    expect(r.status).toBe(200);
    expect(commands).toEqual([{ type: "keypress", key: "Home" }]);
  });
  it("404s an unknown POST verb", async () => {
    const r = await request("POST", "/frobnicate/x");
    expect(r.status).toBe(404);
  });
  it("logs the received command with the client IP at debug (so a support report has a trace)", async () => {
    debugLogs.length = 0;
    await request("POST", "/keypress/Home");
    expect(debugLogs.some(m => /ECP keypress Home from 127\.0\.0\.1/.test(m))).toBe(true);
  });
  it("logs a device-info pairing probe at debug", async () => {
    debugLogs.length = 0;
    await request("GET", "/query/device-info");
    expect(debugLogs.some(m => /device-info queried from 127\.0\.0\.1/.test(m))).toBe(true);
  });
});
