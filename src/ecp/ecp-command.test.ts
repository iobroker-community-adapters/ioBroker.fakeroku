import { parseEcpCommand } from "./ecp-command";

describe("parseEcpCommand", () => {
  it("parses a keypress", () => {
    expect(parseEcpCommand("POST", "/keypress/Home")).toEqual({ type: "keypress", key: "Home" });
  });
  it("normalizes a Lit_ key (URL-decode + every dot)", () => {
    expect(parseEcpCommand("POST", "/keypress/Lit_%C3%A4")).toEqual({ type: "keypress", key: "Lit_ä" });
  });
  it("keeps a malformed percent-escape raw instead of throwing", () => {
    // decodeURIComponent throws on "%ZZ"; inside the request handler that is an
    // uncaught exception — the adapter dies on one bad request from the LAN.
    expect(parseEcpCommand("POST", "/keypress/Lit_%ZZ")).toEqual({ type: "keypress", key: "Lit_%ZZ" });
  });
  it("parses keydown and keyup (hold / release)", () => {
    expect(parseEcpCommand("POST", "/keydown/Select")).toEqual({ type: "keydown", key: "Select" });
    expect(parseEcpCommand("POST", "/keyup/Select")).toEqual({ type: "keyup", key: "Select" });
  });
  it("parses launch and install with the app id", () => {
    expect(parseEcpCommand("POST", "/launch/12")).toEqual({ type: "launch", appId: "12" });
    expect(parseEcpCommand("POST", "/install/13")).toEqual({ type: "install", appId: "13" });
  });

  it("rejects a launch without an app id", () => {
    // Without the argument check this becomes { type: "launch", appId: undefined },
    // which the adapter writes to `command` as the bare string "launch:".
    expect(parseEcpCommand("POST", "/launch")).toBeNull();
    expect(parseEcpCommand("POST", "/install")).toBeNull();
  });
  it("parses input/search and keeps the query text", () => {
    expect(parseEcpCommand("POST", "/search?keyword=news")).toEqual({ type: "search", text: "keyword=news" });
    expect(parseEcpCommand("POST", "/input?a=1")).toEqual({ type: "input", text: "a=1" });
  });
  it("accepts input/search without a query as empty text", () => {
    // Roku's own remote sends a bare /search when the field is cleared. Returning
    // undefined here would put the literal "undefined" into the command state.
    expect(parseEcpCommand("POST", "/search")).toEqual({ type: "search", text: "" });
    expect(parseEcpCommand("POST", "/input")).toEqual({ type: "input", text: "" });
  });
  it("rejects a GET (that is a query, not a command)", () => {
    expect(parseEcpCommand("GET", "/query/device-info")).toBeNull();
    // …including a GET on a real command path: a plain link (or a browser
    // prefetch) must never press a key.
    expect(parseEcpCommand("GET", "/keypress/Home")).toBeNull();
    expect(parseEcpCommand("PUT", "/keypress/Home")).toBeNull();
  });

  it("rejects a path the command pattern does not match at all", () => {
    // Reaching the verb lookup with no match means indexing null — a crash in
    // the request handler instead of a clean 404.
    for (const url of ["/", "", "//", "?x=1"]) {
      expect(parseEcpCommand("POST", url), url).toBeNull();
    }
  });
  it("rejects an unknown verb", () => {
    expect(parseEcpCommand("POST", "/frobnicate/x")).toBeNull();
  });
  it("rejects a key verb without a key", () => {
    expect(parseEcpCommand("POST", "/keypress")).toBeNull();
  });
});
