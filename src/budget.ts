/**
 * Endpoints that spend money on behalf of whoever can reach them.
 *
 * `/agent` makes a model call and `/speak` makes a Polly call, and neither sat
 * behind anything. The general limiter protects the MCP endpoint and these are not
 * on it, so anyone with the URL could run the Anthropic key or the Polly bill up as
 * far as they liked. Nothing here was a bug in the sense of a wrong answer. It was
 * the kind of exposure that only shows up as an invoice.
 *
 * Two limits, because they stop different things.
 *
 * A per caller bucket stops one client hammering. It is small on purpose: a human
 * typing into the stand-in box does not send six requests a minute, and the ones
 * that do are not humans.
 *
 * A daily cap, global to the process, stops many clients together. Each caller can
 * look well behaved while a thousand of them collectively cost more than anyone
 * agreed to, and the per caller bucket cannot see that. When the cap is reached the
 * endpoint says so and the rest of the demo carries on, which is the right failure
 * for a convenience feature.
 *
 * Both are in memory and reset on restart. That is a known gap and an acceptable
 * one: a restart is an operator action, and a caller who can trigger restarts has
 * bigger levers than this.
 */

export type Bucket = { tokens: number; at: number };

/** A token bucket per caller. `perMinute` refills, `burst` is the most ever held. */
export function perCaller(burst: number, perMinute: number) {
  const held = new Map<string, Bucket>();
  return {
    allow(key: string, now = Date.now()): boolean {
      const b = held.get(key) ?? { tokens: burst, at: now };
      const refilled = Math.min(burst, b.tokens + ((now - b.at) / 60_000) * perMinute);
      if (refilled < 1) {
        held.set(key, { tokens: refilled, at: now });
        return false;
      }
      held.set(key, { tokens: refilled - 1, at: now });
      // Forget callers who are back to a full bucket, so the map cannot grow forever.
      if (held.size > 10_000) for (const [k, v] of held) if (v.tokens >= burst - 1) held.delete(k);
      return true;
    },
    size: () => held.size,
    reset: () => held.clear(),
  };
}

/**
 * A cap on total units per fixed period, counted from the Unix epoch: for the backup model, which is meant to last
 * ten days rather than one. In memory, like the daily cap, so a restart starts the period's count again.
 */
export function periodCap(limit: number, periodMs: number) {
  let period = -1;
  let used = 0;
  const roll = (now: number) => {
    const p = Math.floor(now / periodMs);
    if (p !== period) {
      period = p;
      used = 0;
    }
  };
  return {
    take(cost = 1, now = Date.now()): boolean {
      roll(now);
      if (used + cost > limit) return false;
      used += cost;
      return true;
    },
    status(now = Date.now()): { used: number; limit: number; resetsAt: string } {
      roll(now);
      return { used, limit, resetsAt: new Date((period + 1) * periodMs).toISOString() };
    },
  };
}

/** A cap on total units per UTC day. Units are calls for a model and characters for speech. */
export function dailyCap(limit: number) {
  let day = '';
  let used = 0;
  const today = (now: number) => new Date(now).toISOString().slice(0, 10);

  const roll = (now: number) => {
    const d = today(now);
    if (d !== day) {
      day = d;
      used = 0;
    }
  };

  return {
    /** Take `cost` units if there is room. Refuses without consuming when there is not. */
    take(cost = 1, now = Date.now()): boolean {
      roll(now);
      if (used + cost > limit) return false;
      used += cost;
      return true;
    },
    status(now = Date.now()): { used: number; limit: number } {
      roll(now);
      return { used, limit };
    },
    reset(): void {
      day = '';
      used = 0;
    },
  };
}
