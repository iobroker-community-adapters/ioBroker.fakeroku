import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_KEYS, commandToStateWrite, keysForType, MAX_COMMAND_LENGTH, TV_KEYS } from "./state-model";

const root = join(__dirname, "..", "..");

describe("keysForType", () => {
  it("a player exposes the base keys and no TV keys", () => {
    const keys = keysForType("player");
    expect(keys).toEqual([...BASE_KEYS]);
    expect(keys).toContain("Home");
    expect(keys).not.toContain("VolumeUp");
  });
  it("a TV exposes base + TV keys (volume, power, channel, input)", () => {
    const keys = keysForType("tv");
    expect(keys).toEqual([...BASE_KEYS, ...TV_KEYS]);
    for (const k of ["VolumeUp", "PowerOff", "ChannelUp", "InputHDMI1"]) {
      expect(keys).toContain(k);
    }
  });
  it("the admin hint and the README name the real number of player keys", () => {
    // The count itself is free to change; the texts a user reads must follow it.
    const en = JSON.parse(readFileSync(join(root, "admin", "i18n", "en.json"), "utf8")) as Record<string, string>;
    expect(en.deviceTypeHint).toContain(`the ${BASE_KEYS.length} standard`);
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain(`the ${BASE_KEYS.length} standard`);
  });
});

describe("commandToStateWrite", () => {
  it("pulses a standard keypress and records the command", () => {
    expect(commandToStateWrite({ type: "keypress", key: "Home" })).toMatchObject({
      command: "Home",
      commandType: "keypress",
      pulseKey: "Home",
      holdKey: null,
    });
  });
  it("flags a TV key as a pulse too (the adapter guards per device)", () => {
    expect(commandToStateWrite({ type: "keypress", key: "VolumeUp" }).pulseKey).toBe("VolumeUp");
  });
  it("holds on keydown and releases on keyup", () => {
    expect(commandToStateWrite({ type: "keydown", key: "Select" }).holdKey).toEqual({ key: "Select", value: true });
    expect(commandToStateWrite({ type: "keyup", key: "Select" }).holdKey).toEqual({ key: "Select", value: false });
  });
  it("does NOT create a key object for a non-standard Lit_ key — command only", () => {
    const w = commandToStateWrite({ type: "keypress", key: "Lit_a" });
    expect(w.pulseKey).toBeNull();
    expect(w.command).toBe("Lit_a");
  });
  it("records launch and search in the command string, no key pulse", () => {
    expect(commandToStateWrite({ type: "launch", appId: "12" })).toMatchObject({
      command: "launch:12",
      pulseKey: null,
    });
    expect(commandToStateWrite({ type: "search", text: "news" })).toMatchObject({
      command: "search:news",
      pulseKey: null,
    });
  });
});

describe("commandToStateWrite bounds the command text", () => {
  it("cuts an oversized search text to the cap — the URL is client-controlled up to the header limit", () => {
    const text = "x".repeat(MAX_COMMAND_LENGTH * 3);
    expect(commandToStateWrite({ type: "search", text }).command).toHaveLength(MAX_COMMAND_LENGTH);
  });
  it("leaves a normal command untouched", () => {
    expect(commandToStateWrite({ type: "launch", appId: "291097" }).command).toBe("launch:291097");
  });
});

describe("commandToStateWrite with a missing argument", () => {
  it("never puts the word undefined into the command state", () => {
    // commandToStateWrite is called with whatever the ECP layer produced. A verb
    // without its argument must degrade to an empty value, not to "undefined" —
    // that string ends up visible in the user's object tree.
    expect(commandToStateWrite({ type: "keypress" }).command).toBe("");
    expect(commandToStateWrite({ type: "launch" }).command).toBe("launch:");
    expect(commandToStateWrite({ type: "search" }).command).toBe("search:");
  });
});
