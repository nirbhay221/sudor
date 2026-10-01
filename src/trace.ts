/**
 * Being able to answer "what happened on that call".
 *
 * Production guidance for MCP servers converges on one requirement this did not
 * meet: log which tool was invoked, by which client, with what outcome, and make
 * the lines correlatable. What existed was a single line per request with a
 * duration on it:
 *
 *     [mcp] POST 17ms
 *
 * That is enough to notice the turn budget being blown and useless for anything
 * else. It does not say which tool ran, whether it succeeded, which farm it was
 * for, or which of the four background feeds was stale at the time. When somebody
 * reports that the answer was wrong on Tuesday afternoon, there is nothing to look
 * at.
 *
 * So: one JSON line per request, with an id that ties the request line to every
 * error logged while handling it.
 *
 * Why JSON rather than prose. These lines are read by a person once and by a log
 * query many times. `journalctl -u orbita | jq 'select(.tool=="can_i_run" and
 * .ok==false)'` is the question that actually gets asked, and it cannot be asked
 * of a sentence.
 *
 * What is deliberately not in a line. No field names, no coordinates, no crew
 * email addresses, and in the companion add-on no medication or condition. The
 * subject is hashed rather than recorded, so two calls can be recognised as the
 * same customer without the log knowing who they are. A log that has to be
 * protected as carefully as the database is a log nobody will attach to a bug
 * report.
 *
 * Idempotency, which arrives with the same plumbing. Agents retry and parallelise,
 * and the guidance is explicit that a tool should accept a client-generated
 * request id so a retry can be recognised as one. FRICTION.md records that the
 * protocol gave this server nothing to detect duplicates with and that a two
 * minute repeat window was the workaround. The window still stands as the
 * fallback, because most hosts send nothing, but where a host does send an id it
 * is now honoured, which is exact where the window is a guess.
 */

import { createHash, randomBytes } from 'node:crypto';

/** One line per request. Everything is either a number, a bool, or a short string. */
export type Line = {
  t: string;
  id: string;
  /** The MCP method, e.g. tools/call. */
  method?: string;
  /** The tool name, when the request was a tool call. */
  tool?: string;
  ms: number;
  ok: boolean;
  /** Hashed subject, so the same customer is recognisable without being named. */
  who?: string;
  /** Short error class, never a message that might carry customer data. */
  err?: string;
  /** Age in minutes of each background feed at the time of the call. */
  feeds?: Record<string, number | null>;
};

/** Short enough to paste into a bug report, long enough not to collide. */
export function newTraceId(): string {
  return randomBytes(6).toString('hex');
}

/**
 * A stable, non-reversible handle for a subject.
 *
 * Eight hex characters of SHA-256. Enough to correlate a customer's calls across a
 * day of logs, not enough to be a customer identifier, and not reversible to the
 * farm name or OAuth subject it came from.
 */
export function whoHash(subject: string | null | undefined): string | undefined {
  if (!subject) return undefined;
  return createHash('sha256').update(subject).digest('hex').slice(0, 8);
}

/**
 * The error's shape, not its contents.
 *
 * An error message can contain anything the code interpolated into it, which on a
 * bad day is a field name or an address. The constructor name and an HTTP-ish code
 * are what a log needs.
 */
export function errClass(err: unknown): string {
  if (err && typeof err === 'object') {
    // constructor.name first, not .name. A class extending Error does not set
    // .name, so it inherits "Error", and reading that first would flatten every
    // typed SDK error into the same useless label.
    const name = err.constructor?.name || (err as Error).name;
    const status = (err as { status?: number }).status;
    if (name && status) return `${name}:${status}`;
    if (name) return name;
  }
  return 'Error';
}

/** Emit a line. One JSON object, one newline, stdout. */
export function log(line: Line): void {
  // Undefined keys are dropped rather than serialised as null, so a quiet line
  // stays short and a query for a key means the key was relevant.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(line)) if (v !== undefined) clean[k] = v;
  process.stdout.write(`${JSON.stringify(clean)}\n`);
}

/**
 * Pull a client-supplied idempotency key out of a tool call.
 *
 * Three places a host might reasonably put one, checked in order of how
 * standardised they are: the request's `_meta`, an explicit argument, and the
 * JSON-RPC id when it is a string the client chose rather than a counter. A
 * numeric JSON-RPC id is deliberately ignored, because a counter repeats on every
 * reconnect and would make unrelated calls look like retries of each other.
 */
export function idempotencyKey(params: unknown): string | undefined {
  const p = params as
    | { _meta?: Record<string, unknown>; arguments?: Record<string, unknown>; id?: unknown }
    | undefined;
  const meta = p?._meta;
  for (const k of ['idempotencyKey', 'requestId', 'clientRequestId']) {
    const v = meta?.[k] ?? p?.arguments?.[k];
    if (typeof v === 'string' && v.length >= 8 && v.length <= 128) return v;
  }
  return undefined;
}
