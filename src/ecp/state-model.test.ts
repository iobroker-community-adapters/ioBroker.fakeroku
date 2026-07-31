import { BASE_KEYS, commandToStateWrite, keysForType, TV_KEYS } from "./state-model";

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
  it("base has 16 keys, TV adds 11 for 27 total", () => {
    expect(BASE_KEYS.length).toBe(16);
    expect(TV_KEYS.length).toBe(11);
    expect(keysForType("tv").length).toBe(27);
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
    expect(commandToStateWrite({ type: "launch", appId: "12" })).toMatchObject({ command: "launch:12", pulseKey: null });
    expect(commandToStateWrite({ type: "search", text: "news" })).toMatchObject({
      command: "search:news",
      pulseKey: null,
    });
  });
});
