/**
 * Who is allowed to be calling from a browser.
 *
 * The 2025-11-25 specification is explicit that a Streamable HTTP server must
 * answer 403 Forbidden when the `Origin` header is one it does not accept. The
 * attack it closes is DNS rebinding: a page on an attacker's domain resolves a
 * name to 127.0.0.1, then talks to a local MCP server from the victim's own
 * browser, with the victim's own network position. Every same-origin protection
 * the browser offers is satisfied, because from the browser's point of view the
 * request really is going to the origin the page came from.
 *
 * That matters more here than almost anywhere. This server holds the
 * medications somebody takes and the conditions they live with, keyed to where
 * they live. A page the customer happened to leave open in another tab must not
 * be able to read that, or to add a drug to their list.
 *
 * What is allowed:
 *
 *   - A request with no `Origin` at all. This is not a loophole. `Origin` is set
 *     by browsers; curl, the MCP SDK's own client, an Alexa+ host and every
 *     server-to-server caller omit it. Rejecting those would break the actual
 *     product to defend against a browser attack.
 *   - The server's own public URL, so the demo page works.
 *   - localhost and 127.0.0.1 on any port, for development.
 *   - Anything named in SUDOR_ALLOWED_ORIGINS, comma separated.
 *
 * Everything else is 403 before the body is read.
 */

import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const extra = (process.env.SUDOR_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

/** Loopback on any port, http or https, and nothing that merely contains it. */
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function originAllowed(origin: string | undefined, publicUrl?: string): boolean {
  // No Origin header means not a browser. Let it through; the bearer token is
  // what protects this path, and blocking it would break every real client.
  if (!origin) return true;

  const seen = origin.trim().replace(/\/$/, '');
  if (LOOPBACK.test(seen)) return true;

  const own = (publicUrl ?? process.env.SUDOR_PUBLIC_URL ?? '').trim().replace(/\/$/, '');
  if (own && seen === own) return true;

  return extra.includes(seen);
}

/**
 * Reject a disallowed browser origin with 403, before any handler runs.
 *
 * The body is deliberately terse and identical for every rejection: an attacker
 * probing for which origins are accepted learns nothing from it.
 */
export function requireOrigin(req: Request, res: Response, next: NextFunction): void {
  if (originAllowed(req.headers.origin)) return next();
  res.status(403).json({ error: 'forbidden', error_description: 'Origin not allowed.' });
}

/** For tests and /health, so the configured set is inspectable. */
export function allowedOrigins(): string[] {
  return [...extra];
}

/**
 * Proving a request came through the front door.
 *
 * The Origin check above closes DNS rebinding. It does not close the bigger hole,
 * which is that the origin is reachable directly.
 *
 * The intended design put CloudFront in front and narrowed the security group to
 * CloudFront's published origin-facing prefix list, so the instance was not on the
 * open internet at all. CloudFront is unavailable on this account pending
 * verification, so the public address is an API Gateway HTTP API instead, and that
 * changes the problem in a way worth writing down rather than discovering later:
 *
 *   - The integration is HTTP_PROXY to the instance's public DNS name, so the
 *     gateway reaches the origin over the internet.
 *   - AWS publishes no managed prefix list for API Gateway. The list exists for
 *     CloudFront, DynamoDB, Route 53 health checks and a handful of others, and
 *     checking is how this was established rather than assumed.
 *   - So "only allow the gateway" cannot be expressed as a security group rule.
 *     Removing 0.0.0.0/0 does not harden the origin, it takes it offline.
 *
 * What can be expressed is a secret the gateway holds and a caller off the street
 * does not. API Gateway injects it as a request parameter; this refuses anything
 * arriving without it. The port stays open because it has to, and what is behind
 * the port stops being anonymous.
 *
 * Off unless SUDOR_ORIGIN_SECRET is set, so local development and the current
 * deployment keep working unchanged. /health is exempt, because something has to
 * be able to ask whether the process is alive without holding a credential.
 */
const ORIGIN_SECRET = (process.env.SUDOR_ORIGIN_SECRET ?? '').trim();

/** The header API Gateway is configured to append. Lower case: Node lowercases all of them. */
export const ORIGIN_HEADER = 'x-sudor-origin';

export function originSecretConfigured(): boolean {
  return ORIGIN_SECRET.length > 0;
}

/**
 * Constant-time compare, because a timing oracle on this would hand out the
 * secret one byte at a time.
 */
function sameSecret(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(ORIGIN_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireOriginSecret(req: Request, res: Response, next: NextFunction): void {
  if (!ORIGIN_SECRET) return next();
  if (req.path === '/health') return next();
  const given = req.headers[ORIGIN_HEADER];
  if (typeof given === 'string' && sameSecret(given)) return next();
  // Identical body for every rejection: a prober learns nothing about whether the
  // header was missing, malformed, or simply wrong.
  res.status(403).json({ error: 'forbidden' });
}
