import * as http from "node:http";
import type { CommandEvent } from "./ecp-command";
import { EcpHttpServer } from "./ecp-http-server";

const PORT = 18099;
const debugLogs: string[] = [];
const warnLogs: string[] = [];
const noopLog = {
  debug: (m: string): void => {
    debugLogs.push(m);
  },
  warn: (m: string): void => {
    warnLogs.push(m);
  },
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
  /** Swappable command sink, so one test can make the adapter's handler throw. */
  let onCommandImpl: (c: CommandEvent) => void = c => {
    commands.push(c);
  };
  let server: EcpHttpServer;

  beforeAll(async () => {
    server = new EcpHttpServer({
      device: { uuid: "abc123", port: PORT },
      friendlyName: "Test Roku",
      apps: [{ id: "12", name: "Netflix" }],
      deviceType: "player",
      bindIp: "127.0.0.1",
      logger: noopLog,
      onCommand: c => onCommandImpl(c),
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
  it("answers a malformed keyboard keypress instead of crashing on it", async () => {
    commands.length = 0;
    const r = await request("POST", "/keypress/Lit_%ZZ");
    expect(r.status).toBe(200);
    expect(commands).toEqual([{ type: "keypress", key: "Lit_%ZZ" }]);
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
  it("answers 403 to a non-LAN client and runs no command", () => {
    // A real socket from a public address cannot be produced in-process, so the
    // handler is driven directly. This is the guard that keeps a port-forwarded
    // or VLAN-crossing request from pressing keys in someone's living room.
    commands.length = 0;
    debugLogs.length = 0;
    const res = {
      statusCode: 0,
      setHeader: (): void => {},
      end: (): void => {},
    } as unknown as http.ServerResponse;
    const req = {
      socket: { remoteAddress: "8.8.8.8" },
      method: "POST",
      url: "/keypress/Home",
    } as unknown as http.IncomingMessage;

    (server as unknown as { handle(q: http.IncomingMessage, s: http.ServerResponse): void }).handle(req, res);

    expect(res.statusCode).toBe(403);
    expect(commands).toEqual([]);
    expect(debugLogs.some(m => m.includes("non-LAN 8.8.8.8"))).toBe(true);
  });

  it("logs a device-info pairing probe at debug", async () => {
    debugLogs.length = 0;
    await request("GET", "/query/device-info");
    expect(debugLogs.some(m => /device-info queried from 127\.0\.0\.1/.test(m))).toBe(true);
  });

  it("handles a request without a method, url or peer address", () => {
    // http.IncomingMessage types all three as optional, and a malformed request
    // line reaches the handler with them missing. A crash here kills the adapter.
    debugLogs.length = 0;
    const res = { statusCode: 0, setHeader: (): void => {}, end: (): void => {} } as unknown as http.ServerResponse;
    const req = { socket: {} } as unknown as http.IncomingMessage;
    const h = server as unknown as { handle(q: http.IncomingMessage, s: http.ServerResponse): void };
    expect(() => h.handle(req, res)).not.toThrow();
    // No remote address at all is not a LAN client — a missing peer must not be
    // treated as trusted.
    expect(res.statusCode).toBe(403);
    expect(debugLogs.some(m => m.includes("non-LAN ?"))).toBe(true);
  });

  it("treats a request without a method or url as a GET of the root description", () => {
    // Both are optional in http.IncomingMessage. A missing method would otherwise
    // fall through to 405 and a missing url would throw on url.split().
    let body = "";
    const res = {
      statusCode: 0,
      setHeader: (): void => {},
      end: (b?: string): void => {
        body = b ?? "";
      },
    } as unknown as http.ServerResponse;
    const req = { socket: { remoteAddress: "127.0.0.1" } } as unknown as http.IncomingMessage;
    const h = server as unknown as { handle(q: http.IncomingMessage, s: http.ServerResponse): void };
    expect(() => h.handle(req, res)).not.toThrow();
    expect(res.statusCode).toBe(200);
    expect(body).toContain("urn:roku-com:device:player:1-0");
  });

  it("logs the command's argument, whichever field carries it", async () => {
    debugLogs.length = 0;
    await request("POST", "/launch/12");
    await request("POST", "/search?keyword=news");
    // "I pressed a button and nothing happened" is only diagnosable if the log
    // says WHAT arrived — the argument lives in a different field per verb.
    expect(debugLogs.some(m => m.includes("ECP launch 12 from"))).toBe(true);
    expect(debugLogs.some(m => m.includes("ECP search keyword=news from"))).toBe(true);
  });

  it("keeps a decoded control character out of the log line", async () => {
    debugLogs.length = 0;
    await request("POST", "/keypress/Lit_%0Ainjected");
    // A newline in the key would end the log entry early and start a fake second one.
    const line = debugLogs.find(m => m.startsWith("ECP keypress"));
    expect(line).toBeDefined();
    expect(line).not.toContain("\n");
    expect(line).toContain("Lit_?injected");
  });

  it("logs a command that carries no argument without a trailing space", async () => {
    debugLogs.length = 0;
    await request("POST", "/search");
    expect(debugLogs.some(m => /^ECP search from /.test(m))).toBe(true);
  });

  it("stop is safe before start and when called twice", () => {
    const idle = new EcpHttpServer({
      device: { uuid: "zzz", port: 1 },
      friendlyName: "never started",
      apps: [],
      deviceType: "player",
      bindIp: undefined,
      logger: noopLog,
      onCommand: () => {},
    });
    // onUnload calls stop() unconditionally, including for a device whose start
    // threw on a busy port — a throw there costs the callback and means SIGKILL.
    expect(() => idle.stop()).not.toThrow();
    expect(() => idle.stop()).not.toThrow();
  });

  it("stop is safe after a start that failed on a busy port", async () => {
    const blocker = http.createServer();
    await new Promise<void>(resolve => blocker.listen(PORT + 1, "127.0.0.1", resolve));
    const busy = new EcpHttpServer({
      device: { uuid: "busy", port: PORT + 1 },
      friendlyName: "busy",
      apps: [],
      deviceType: "player",
      bindIp: "127.0.0.1",
      logger: noopLog,
      onCommand: () => {},
    });
    try {
      await expect(busy.start()).rejects.toThrow(/EADDRINUSE/);
      // main.ts closes the failed server; a throw here would abort the device loop.
      expect(() => busy.stop()).not.toThrow();
    } finally {
      blocker.close();
    }
  });

  it("serves the advertised app list", async () => {
    const r = await request("GET", "/query/apps");
    // A remote that gets a 404 here shows an empty app row or aborts the pairing —
    // the endpoint is part of every controller's probe sequence.
    expect(r.status).toBe(200);
    expect(r.body).toContain("Netflix");
    expect(r.body).toContain('id="12"');
  });

  it("answers an unsupported method with 405, not a fake success", async () => {
    commands.length = 0;
    for (const method of ["PUT", "DELETE"]) {
      const r = await request(method, "/keypress/Home");
      // A 200 tells the controller the key arrived — it never did. The user then
      // hunts for the bug in ioBroker instead of in the controller's request.
      expect(r.status).toBe(405);
    }
    expect(commands).toEqual([]);
  });

  it("survives a throwing command handler and still answers the remote", async () => {
    warnLogs.length = 0;
    onCommandImpl = () => {
      throw new Error("state write failed");
    };
    try {
      const r = await request("POST", "/keypress/Home");
      // The handler runs inside the HTTP callback: an escaping throw would take the
      // whole adapter process down over one failed state write, and the controller
      // would sit on a dead socket.
      expect(r.status).toBe(200);
      expect(warnLogs.some(m => m.includes("onCommand failed: state write failed"))).toBe(true);
    } finally {
      onCommandImpl = c => {
        commands.push(c);
      };
    }
  });
});
