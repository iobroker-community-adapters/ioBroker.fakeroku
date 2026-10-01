/**
 * At most one log line per kind and interval — so a peer that repeats a problem (a scanner, a flooding remote, a
 * failing socket) cannot fill the log. Pure apart from the default clock.
 */
export class LogThrottle {
  private readonly lastAt = new Map<string, number>();

  /**
   * @param intervalMs how long a kind stays quiet after a line was written
   */
  public constructor(private readonly intervalMs: number) {}

  /**
   * Whether a line of this kind may be written now; a yes counts as written.
   *
   * @param kind what the line is about (a device id, "drop", "socket" …)
   * @param now the current time in milliseconds
   * @returns true if the line may be written
   */
  public due(kind: string, now: number = Date.now()): boolean {
    const last = this.lastAt.get(kind);
    if (last !== undefined && now - last < this.intervalMs) {
      return false;
    }
    this.lastAt.set(kind, now);
    return true;
  }
}
