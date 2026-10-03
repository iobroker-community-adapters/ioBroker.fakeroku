// Guard of K20 (krobi 2026-10-02 23:52, "absolut wichtig"): the device dialog blocks "OK" while name or port collide
// and names the reason. Sealed in the register — a change goes through the Werkbank.
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/i18n", () => ({
  t: (key: string, ...args: unknown[]) => (args.length > 0 ? `${key}(${args.join(",")})` : key),
  tName: (key: string) => ({ en: key }),
  tDesc: (key: string) => ({ en: key }),
  tRaw: (text: string) => ({ en: text }),
}));

import { buildDeviceForm } from "../device-management";

/**
 * Evaluate a dialog rule the way the admin does: a JavaScript expression over the form data.
 *
 * @param expression the rule
 * @param data the form data
 * @returns its value
 */
function rule(expression: string, data: Record<string, unknown>): boolean {
  return runInNewContext(`(${expression})`, { data }) as boolean;
}

describe("K20 — OK is blocked on a clash, and the dialog says why", () => {
  const form = buildDeviceForm(["Wohnzimmer"], [8060], ["Wohnzimmer"]);
  const items = (form.schema as unknown as { items: Record<string, { text?: unknown; hidden?: string }> }).items;

  it("blocks OK for a name in use, for a port in use, and lets a free pair through", () => {
    expect(rule(form.applyDisabledRule, { name: "Wohnzimmer", port: 8061 })).toBe(true);
    expect(rule(form.applyDisabledRule, { name: "Kino", port: 8060 })).toBe(true);
    expect(rule(form.applyDisabledRule, { name: "Kino", port: 8061 })).toBe(false);
  });

  it("shows the reason for the name clash and for the port clash", () => {
    expect(items._nameRejected.text).toBe("deviceNameRejected");
    expect(rule(items._nameRejected.hidden!, { name: "Wohnzimmer", port: 8061 })).toBe(false);
    expect(rule(items._nameRejected.hidden!, { name: "Kino", port: 8061 })).toBe(true);
    expect(items._portRejected.text).toBe("devicePortInUse");
    expect(rule(items._portRejected.hidden!, { name: "Kino", port: 8060 })).toBe(false);
    expect(rule(items._portRejected.hidden!, { name: "Kino", port: 8061 })).toBe(true);
  });
});
