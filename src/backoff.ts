/**
 * Not hammering a feed that is down.
 *
 * Every background feed here polls on a fixed timer and, when a poll fails, keeps the
 * last good answer and tries again next tick. That is the right thing for a blip and
 * the wrong thing for an endpoint that has gone away for a day: it is asked again
 * every few minutes for ever, which wastes a request nobody needs, and for a free
 * public service it is also how a client gets itself blocked.
 *
 * So after a run of failures the next attempts are pushed out, doubling up to a
 * ceiling, with jitter so a fleet of clients does not all come back on the same
 * second. The exponential-backoff-with-jitter shape is the standard one. A single
 * success puts everything back to normal immediately.
 *
 * Three failures in a row before anything changes. One or two are the ordinary
 * weather of the internet, and a boot that misses its first poll is retried within
 * a minute by the callers precisely because a short outage should heal fast. The
 * breaker only ever makes a *persistent* outage cheaper.
 *
 * What it never does is change what a caller is told. The last good data keeps its
 * own freshness rules; this only decides whether to make another request.
 */

export type Backoff = ReturnType<typeof backoff>;

export function backoff(opts: { after?: number; baseMs?: number; capMs?: number; random?: () => number } = {}) {
  const after = opts.after ?? 3;
  const baseMs = opts.baseMs ?? 5 * 60 * 1000;
  const capMs = opts.capMs ?? 60 * 60 * 1000;
  const random = opts.random ?? Math.random;

  let failures = 0;
  let nextAt = 0;

  return {
    /** Whether it is time to try again. */
    ready(now = Date.now()): boolean {
      return now >= nextAt;
    },
    ok(): void {
      failures = 0;
      nextAt = 0;
    },
    fail(now = Date.now()): void {
      failures += 1;
      if (failures < after) return;
      const ceiling = Math.min(capMs, baseMs * 2 ** (failures - after));
      // Between half and all of the ceiling: enough spread to avoid a thundering
      // herd, and never so short that the back-off is a formality.
      nextAt = now + ceiling * (0.5 + random() * 0.5);
    },
    state(now = Date.now()): { failures: number; retryInSeconds: number } {
      return { failures, retryInSeconds: Math.max(0, Math.round((nextAt - now) / 1000)) };
    },
    reset(): void {
      failures = 0;
      nextAt = 0;
    },
  };
}
