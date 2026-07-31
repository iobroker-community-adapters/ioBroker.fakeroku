import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Manifest wiring the integration boot test cannot see. The device manager only
 * works if `common.supportedMessages.deviceManager` is set: without it the
 * js-controller delivers no `dm:*` message, so neither the add button nor the
 * device cards appear — yet the adapter still boots green. This locks the flag on.
 */
describe("io-package.json manifest", () => {
  const io = JSON.parse(readFileSync(join(__dirname, "..", "io-package.json"), "utf8")) as {
    common?: { supportedMessages?: { deviceManager?: boolean } };
  };

  it("enables device-manager messages (common.supportedMessages.deviceManager)", () => {
    expect(io.common?.supportedMessages?.deviceManager).toBe(true);
  });
});
