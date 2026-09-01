/**
 * A token bucket: `perSecond` commands are allowed in any second, the excess is
 * refused. Pure — the caller passes the clock — so the rule is unit-testable
 * without waiting.
 *
 * Why it exists: every accepted command becomes three state writes (plus one more
 * when the key pulse ends). A misbehaving or hostile device in the LAN could send
 * a thousand key presses a second and turn this adapter into a write flood
 * against the ioBroker database — slowing the host, every history adapter on
 * these datapoints and everything else running there. Real remotes send a handful
 * of presses a second at most, so the cap costs legitimate use nothing.
 */
export class RateGate {
  private tokens: number;
  private last: number;

  /**
   * @param perSecond how many commands may pass per second (also the burst size)
   * @param now the current time in milliseconds
   */
  public constructor(
    private readonly perSecond: number,
    now: number,
  ) {
    this.tokens = perSecond;
    this.last = now;
  }

  /**
   * Take one token if there is one.
   *
   * @param now the current time in milliseconds
   * @returns true if the command may pass, false if it exceeds the rate
   */
  public allow(now: number): boolean {
    // A clock that jumps backwards must not lend tokens from the future.
    const elapsedSeconds = Math.max(0, now - this.last) / 1000;
    this.tokens = Math.min(this.perSecond, this.tokens + elapsedSeconds * this.perSecond);
    this.last = now;
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }
}
