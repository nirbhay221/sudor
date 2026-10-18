/**
 * What every MCP request passes through before a tool sees it: arguments that would break parsing,
 * an Accept header a plain client sends, and a ceiling on how fast one caller is served.
 */

import type express from 'express';
import { callerKey } from './caller.js';

/**
 * Strips the three keys that break argument parsing.
 *
 * Found by fuzzing: a tools/call whose arguments contain a key named "constructor" is answered with
 * "-32603 Internal error" and a raw dump of a validation library's issue list, from any tool, because the
 * SDK's schema parsing trips over a key that collides with Object.prototype. That is an upstream bug, and
 * the effect for us is the thing Amazon's requirements say never to do: expose an internal error. No
 * tool takes arguments with these names, so they are removed from the arguments before the request
 * reaches the SDK, and the call then behaves exactly like any other call with an argument nobody asked for.
 */
const UNSAFE_KEYS = ['constructor', 'prototype', '__proto__'];
function stripUnsafeKeys(value: unknown, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 8) return;
  for (const key of UNSAFE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) delete (value as Record<string, unknown>)[key];
  }
  for (const child of Object.values(value as Record<string, unknown>)) stripUnsafeKeys(child, depth + 1);
}
export const dropUnsafeArguments: express.RequestHandler = (req, _res, next) => {
  const body = req.body as unknown;
  for (const message of Array.isArray(body) ? body : [body]) {
    const params = (message as { params?: { arguments?: unknown } } | null)?.params;
    if (params?.arguments) stripUnsafeKeys(params.arguments);
  }
  next();
};

/**
 * A client that will take anything does take both of the two types the
 * transport insists on.
 *
 * The Streamable HTTP transport rejects a POST unless Accept names both
 * application/json and text/event-stream, which is what the spec asks clients
 * to send. But curl's default Accept is the wildcard, and a probe found that a
 * plain curl to this endpoint came back 406, which reads as a broken server
 * rather than a picky one. A wildcard is rewritten to the pair it already
 * covers. An Accept that names application/json and nothing else is left to be
 * refused, because that client really cannot read the stream we answer with.
 */
export const widenWildcardAccept: express.RequestHandler = (req, _res, next) => {
  const accept = String(req.headers.accept ?? '').trim();
  const wildcard = !accept || accept.split(',').some((part) => part.trim().split(';')[0] === '*/*');
  if (wildcard) req.headers.accept = 'application/json, text/event-stream';
  next();
};


/**
 * A ceiling on how fast one caller can be served.
 *
 * The specification's security section asks servers to rate limit tool
 * invocations, and this endpoint is public. A token bucket: a burst of
 * __BURST__ is fine, and it refills at __RATE__ a second, which is far above
 * anything a voice conversation does and far below what a script does. The
 * bucket is per caller, so one noisy visitor cannot spend everyone else's.
 */
const BURST = Number(process.env.SUDOR_BURST ?? 600);
const REFILL_PER_SECOND = Number(process.env.SUDOR_REFILL ?? 10);
const buckets = new Map<string, { tokens: number; at: number }>();

function withinRate(key: string): boolean {
  const now = Date.now();
  const held = buckets.get(key) ?? { tokens: BURST, at: now };
  const refilled = Math.min(BURST, held.tokens + ((now - held.at) / 1000) * REFILL_PER_SECOND);
  if (refilled < 1) {
    buckets.set(key, { tokens: refilled, at: now });
    return false;
  }
  buckets.set(key, { tokens: refilled - 1, at: now });
  // Callers who have gone quiet and are back to a full bucket cost nothing to forget.
  if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.tokens >= BURST - 1) buckets.delete(k);
  return true;
}

export const rateLimit: express.RequestHandler = (req, res, next) => {
  const key = callerKey(req);
  if (withinRate(key)) return next();
  res.status(429).set('Retry-After', '1').json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Too many requests. Slow down and try again in a moment.' },
    id: null,
  });
};
