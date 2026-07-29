import { commandToStateWrite, STANDARD_KEYS } from "./state-model";

describe("STANDARD_KEYS", () => {
  it("covers the core Roku remote (Home, Play, arrows, volume, power, HDMI)", () => {
    for (const k of ["Home", "Play", "Up", "VolumeUp", "PowerOff", "InputHDMI1"]) {
      expect(STANDARD_KEYS).toContain(k);
    }
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
