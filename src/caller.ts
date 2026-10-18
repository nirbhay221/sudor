/**
 * Who a request is for, and who to charge for it. Used by every route in server.ts, guards.ts and standin.ts.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type express from 'express';
import { AUTH_ON, demoIdOf, subjectOf } from './auth.js';

/** Whose medications and location these are. See auth.ts for what set this. */
export function personFrom(req: express.Request): string {
  const subject = subjectOf(req);
  if (subject) return `acct:${subject}`;
  // A profile holds medications and conditions, so two visitors must never share
  // one. Each browser has its own 128 bit id, and it only ever reaches `demo:`.
  const demo = demoIdOf(req);
  if (demo) return `demo:${demo}`;
  if (AUTH_ON) throw new Error('unauthenticated request reached the MCP handler');
  return 'local-dev';
}

/*
 * Who to charge for this request, worked out before authentication has run.
 * personFrom throws on an unauthenticated request when auth is on, which is the
 * right thing for a tool call and the wrong thing here: a limiter that throws
 * turns a 401 into a 500, which a probe caught immediately.
 */
export const callerKey = (req: express.Request): string => {
  try {
    const who = personFrom(req);
    // A linked account is a stable identity and is charged as itself. A sandbox
    // identity is not: anyone can invent a new 128 bit id for free, so keying the
    // limiter on it gives every request a fresh bucket and turns every per caller
    // limit, including the ones on the paid endpoints, into decoration. Sandbox
    // callers are charged by network address instead.
    if (who.startsWith('acct:')) return who;
    return `ip:${req.ip ?? 'unknown'}`;
  } catch {
    return `ip:${req.ip ?? 'unknown'}`;
  }
};

/**
 * The same key, for code a request reaches that has no request to read it from: a tool. Set around each MCP
 * request in server.ts. A limiter inside a tool that keyed on the person was keyed on a sandbox id anyone can
 * make up, so every made-up id came with a fresh allowance of guesses at somebody's share code.
 */
export const requestCaller = new AsyncLocalStorage<string>();
export const currentCaller = (fallback: string): string => requestCaller.getStore() ?? fallback;
