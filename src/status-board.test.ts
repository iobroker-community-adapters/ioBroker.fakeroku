import { StatusBoard, type StatusNow } from "./status-board";

/**
 * A host with a state store, a log of the writes that reached it, and a switch that fails the next write.
 *
 * @param stored the states the database holds, by id relative to the namespace
 * @returns the board and what the host saw
 */
function host(stored: Record<string, Partial<ioBroker.State> | null> = {}): {
  board: StatusBoard;
  writes: [string, unknown][];
  reads: string[];
  failNext: () => void;
} {
  const writes: [string, unknown][] = [];
  const reads: string[] = [];
  let fail = false;
  const board = new StatusBoard({
    namespace: "fakeroku.0",
    getStatesAsync: pattern => {
      reads.push(pattern);
      const out: Record<string, ioBroker.State | null> = {};
      for (const [id, state] of Object.entries(stored)) {
        out[`fakeroku.0.${id}`] = state as ioBroker.State | null;
      }
      return Promise.resolve(out);
    },
    setState: (id, state) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error("states database gone"));
      }
      writes.push([id, (state as ioBroker.State).val]);
      return Promise.resolve();
    },
  });
  return { board, writes, reads, failNext: () => (fail = true) };
}

/** One Roku that listens, everything green. */
const green: StatusNow = { devices: [["Kino", ""]], total: 1, online: 1, allOnline: true, healthy: true };

describe("StatusBoard", () => {
  it("writes every indicator once, and a second pass with the same values writes nothing", async () => {
    const h = host();
    await h.board.primeStates();
    await h.board.show(green);
    expect(h.writes).toEqual([
      ["Kino.info.online", true],
      ["Kino.info.error", ""],
      ["info.devicesTotal", 1],
      ["info.devicesOnline", 1],
      ["info.devicesAllOnline", true],
      ["info.connection", true],
    ]);
    h.writes.length = 0;
    await h.board.show(green);
    expect(h.writes).toEqual([]);
  });

  it("writes a value the database holds unconfirmed (ack false) again", async () => {
    const h = host({ "info.connection": { val: true, ack: false } });
    await h.board.primeStates();
    await h.board.show(green);
    expect(h.writes).toContainEqual(["info.connection", true]);
  });

  it("writes a value the database holds with a quality flag again", async () => {
    const h = host({ "info.connection": { val: true, ack: true, q: 0x42 } });
    await h.board.primeStates();
    await h.board.show(green);
    expect(h.writes).toContainEqual(["info.connection", true]);
  });

  it("compares the value strictly: a stored string is not the number it reads like", async () => {
    const h = host({ "info.devicesOnline": { val: "1", ack: true } });
    await h.board.primeStates();
    await h.board.show(green);
    expect(h.writes).toContainEqual(["info.devicesOnline", 1]);
  });

  it("hands a failed write to the caller and forgets it, so the next pass writes it again", async () => {
    const h = host();
    await h.board.primeStates();
    h.failNext();
    await expect(h.board.markOffline([])).rejects.toThrow("states database gone");
    const failed = ["info.devicesOnline", "info.devicesAllOnline", "info.connection"].find(
      id => !h.writes.some(([written]) => written === id),
    );
    expect(failed).toBeDefined();
    h.writes.length = 0;
    await h.board.markOffline([]);
    expect(h.writes.map(([id]) => id)).toEqual([failed]);
  });

  it("reads the own states in ONE bulk read and skips a state that expired between key and value", async () => {
    const h = host({ "Kino.info.online": null, "Kino.keys.Home": { val: true, ack: true } });
    await h.board.primeStates();
    expect(h.reads).toEqual(["fakeroku.0.*"]);
    expect(h.board.stored("Kino.info.online")).toBeUndefined();
    expect(h.board.stored("Kino.keys.Home")).toEqual({ val: true, ack: true, q: undefined });
  });

  it("finds the Rokus by their status datapoints only", async () => {
    const h = host({
      "Kino.info.online": { val: true, ack: true },
      "Bad.info.error": { val: "", ack: true },
      "Flur.keys.Home": { val: false, ack: true },
      "info.connection": { val: true, ack: true },
    });
    await h.board.primeStates();
    expect(h.board.storedStatusDevices().sort()).toEqual(["Bad", "Kino"]);
  });

  it("remembers a value written past it, so the same value is not written again", async () => {
    const h = host();
    await h.board.primeStates();
    h.board.remember("info.connection", false);
    await h.board.markOffline([]);
    expect(h.writes.map(([id]) => id)).not.toContain("info.connection");
  });
});
