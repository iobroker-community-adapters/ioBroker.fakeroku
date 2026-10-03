// Guard of K19 (krobi 2026-10-02 23:52, taken over): UDP 1900 is shared — several Rokus and several instances on one
// host. Sealed in the register — a change goes through the Werkbank.
import { describe, expect, it } from "vitest";
import { RokuSsdpResponder } from "../discovery/ssdp-responder";

/**
 * A responder for one emulated Roku that answers nobody — only its socket on port 1900 matters here.
 *
 * @param uuid the identity it announces
 * @returns the responder
 */
function responder(uuid: string): RokuSsdpResponder {
  return new RokuSsdpResponder({
    devices: [{ uuid, port: 18060 }],
    bindIp: undefined,
    advertiseIp: "127.0.0.1",
    membershipInterfaces: [],
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
    isClientAllowed: () => false,
    onFatalError: () => {},
  });
}

describe("K19 — UDP 1900 is shared", () => {
  it("lets a second responder start on port 1900 while the first one holds it", async () => {
    const first = responder("guard000000000000000000000k19a");
    const second = responder("guard000000000000000000000k19b");
    try {
      const one = await first.start().then(
        () => "listening",
        (e: unknown) => String(e),
      );
      const two = await second.start().then(
        () => "listening",
        (e: unknown) => String(e),
      );
      expect([one, two]).toEqual(["listening", "listening"]);
    } finally {
      first.stop();
      second.stop();
    }
  });
});
