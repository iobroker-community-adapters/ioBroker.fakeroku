import { parseEcpCommand } from "./ecp-command";

describe("parseEcpCommand", () => {
  it("parses a keypress", () => {
    expect(parseEcpCommand("POST", "/keypress/Home")).toEqual({ type: "keypress", key: "Home" });
  });
  it("normalizes a Lit_ key (URL-decode + every dot)", () => {
    expect(parseEcpCommand("POST", "/keypress/Lit_%C3%A4")).toEqual({ type: "keypress", key: "Lit_ä" });
  });
  it("parses keydown and keyup (hold / release)", () => {
    expect(parseEcpCommand("POST", "/keydown/Select")).toEqual({ type: "keydown", key: "Select" });
    expect(parseEcpCommand("POST", "/keyup/Select")).toEqual({ type: "keyup", key: "Select" });
  });
  it("parses launch and install with the app id", () => {
    expect(parseEcpCommand("POST", "/launch/12")).toEqual({ type: "launch", appId: "12" });
    expect(parseEcpCommand("POST", "/install/13")).toEqual({ type: "install", appId: "13" });
  });
  it("parses input/search and keeps the query text", () => {
    expect(parseEcpCommand("POST", "/search?keyword=news")).toEqual({ type: "search", text: "keyword=news" });
    expect(parseEcpCommand("POST", "/input?a=1")).toEqual({ type: "input", text: "a=1" });
  });
  it("rejects a GET (that is a query, not a command)", () => {
    expect(parseEcpCommand("GET", "/query/device-info")).toBeNull();
  });
  it("rejects an unknown verb", () => {
    expect(parseEcpCommand("POST", "/frobnicate/x")).toBeNull();
  });
  it("rejects a key verb without a key", () => {
    expect(parseEcpCommand("POST", "/keypress")).toBeNull();
  });
});
