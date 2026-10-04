/**
 * OAuth 2.1 for the MCP endpoint.
 *
 * Alexa+ will not link an account without this. The published checklist is
 * specific: authorization code flow with PKCE, `code_challenge_methods_supported`
 * containing S256, and metadata a client can discover before it has any token.
 * Account linking does not proceed if S256 is missing.
 *
 * What is implemented here:
 *   RFC 9728  protected resource metadata   /.well-known/oauth-protected-resource
 *   RFC 8414  authorization server metadata /.well-known/oauth-authorization-server
 *   RFC 7591  dynamic client registration   POST /oauth/register
 *   OAuth 2.1 authorization code + PKCE     GET  /oauth/authorize, POST /oauth/token
 *
 * The sign-in page is deliberately a stub: a farm has no user database, and a
 * fake one would be security theatre. It takes an account name, and that name
 * becomes the subject the tools scope data to. Everything around it, the PKCE
 * check, single-use codes, exact redirect matching, token rotation, is real,
 * because that is the part Alexa+ actually exercises.
 *
 * Tokens live in memory. A restart signs everyone out. Said plainly rather than
 * pretending a Map is a session store.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import * as store from './authstore.js';
import { perCaller } from './budget.js';

const CODE_TTL_MS = 60_000;
const ACCESS_TTL_MS = 60 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * The public demo page, which has no account to link.
 *
 * With auth on, the demo page could not work at all: it calls /mcp anonymously, and
 * an anonymous call was a 401. That conflict is why auth stayed off on the public
 * endpoint, which left the real accounts behind it exactly as open as the demo.
 * Two different things were sharing one door.
 *
 * They get two doors. A demo identity is `demo:<id>`, a namespace no linked account
 * can occupy (those are `acct:<name>`), so a visitor can reach nothing but the
 * sandbox they made for themselves. With SUDOR_DEMO=off, the default for a
 * deployment serving only real customers, there is no anonymous door at all.
 */
export const DEMO_ON = (process.env.SUDOR_DEMO ?? 'on').toLowerCase() !== 'off';

/**
 * 128 random bits as hex, and nothing shorter.
 *
 * The id is the only thing standing between a stranger and a visitor's medication
 * list. The page used to build it from Math.random() in base 36, about 41 bits from
 * a generator that is explicitly not for secrets, plus a timestamp anybody can
 * estimate. Short enough to guess and dressed up as an identifier.
 */
export const DEMO_ID = /^[a-f0-9]{32}$/;

export function demoIdOf(req: Request): string | null {
  if (!DEMO_ON) return null;
  const id = String(req.get('x-sudor-demo') ?? '');
  return DEMO_ID.test(id) ? id : null;
}

/** Auth is off unless asked for, so the local probe and tests keep working. */
export const AUTH_ON = (process.env.SUDOR_AUTH ?? 'off').toLowerCase() === 'on';

/**
 * Alexa+ account linking, confirmed against Amazon's own docs
 * (category-sdk-mcp-account-linking.html), does not match the generic MCP
 * OAuth shape this file originally implemented:
 *
 *   "Alexa+ add-ons support only the Authorization Code Grant."
 *   "Dynamic Client Registration (DCR) isn't supported."
 *
 * The developer picks their own client_id, runs
 * `alexa-ai configure-account-linking --client-id <id>`, and the CLI hands
 * back Alexa's own set of redirect URIs to register, plural, one per region:
 * "use exactly the value Alexa passes, don't hardcode a single URI." DCR issuing
 * a fresh client_id to anyone who calls /oauth/register is the opposite shape.
 *
 * So the client Alexa+ actually links against is pre-registered here from
 * environment variables at boot, a static client in the sense Amazon means
 * it, not negotiated at runtime. DCR is kept only as a development
 * convenience, for the KayLerch bridge and local testing, where it is a
 * reasonable stand-in precisely because it is not the real Alexa+ client.
 */
const STATIC_CLIENT_ID = process.env.SUDOR_CLIENT_ID;
const STATIC_REDIRECT_URIS = (process.env.SUDOR_REDIRECT_URIS ?? '')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);

type Client = { id: string; redirectUris: string[]; name: string };
type Code = {
  clientId: string;
  redirectUri: string;
  challenge: string;
  subject: string;
  expires: number;
};

const clients = new Map<string, Client>();
const codes = new Map<string, Code>();
// Access and refresh tokens live in authstore.ts, keyed by the SHA-256 of the token
// and persisted, so a deploy no longer signs every linked account out and a copy of
// the file cannot be replayed.

const now = () => Date.now();
const secret = () => randomBytes(32).toString('base64url');

/** base64url(SHA256(verifier)), the S256 transformation from RFC 7636. */
export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Constant-time compare of the S256 challenge. `plain` is refused outright:
 * OAuth 2.1 drops it, and accepting it would defeat the point of PKCE.
 */
export function verifyPkce(verifier: string, challenge: string, method = 'S256'): boolean {
  if (method !== 'S256') return false;
  if (!verifier || verifier.length < 43 || verifier.length > 128) return false;
  const a = Buffer.from(pkceS256(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The public origin. Derived per request so a cloudflared tunnel just works. */
export function originOf(req: Request): string {
  const configured = process.env.SUDOR_PUBLIC_URL;
  if (configured) return configured.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function expire(): void {
  // Idempotent, and cheap once the file has been read. A token lookup that only
  // works because something else happened to load the file first is a bug waiting
  // for a refactor, so every lookup makes sure.
  store.load();
  const t = now();
  // Codes stay in memory on purpose: they live for sixty seconds and are single
  // use, so surviving a restart would only extend a window nobody asked for.
  for (const [k, v] of codes) if (v.expires < t) codes.delete(k);
  store.prune(t);
}

/** The subject a request is acting as, or null when it carries no valid token. */
export function subjectOf(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  expire();
  const token = store.access.get(store.hashToken(header.slice(7).trim()));
  return token && token.expires > now() ? token.subject : null;
}

/**
 * Gate for /mcp. A 401 has to name where the metadata lives, otherwise the
 * client has no way to discover the authorization server and start linking.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!AUTH_ON) return next();
  if (subjectOf(req)) return next();
  // The sandbox. A linked account's token is checked first, so a demo header can
  // never stand in for one.
  if (demoIdOf(req)) return next();
  res
    .status(401)
    .set(
      'WWW-Authenticate',
      `Bearer realm="sudor", error="invalid_token", resource_metadata="${originOf(req)}/.well-known/oauth-protected-resource"`,
    )
    .json({ error: 'invalid_token', error_description: 'Link your account to use Sudor.' });
}


type ConsentFields = { client_id: string; redirect_uri: string; code_challenge: string; state: string };

/**
 * The link page. A function rather than inline markup because a refused attempt has
 * to show it again with the reason, and re-rendering must never lose the OAuth
 * parameters that were carried in hidden fields.
 */
function consentPage(client: Client, f: ConsentFields, error?: string, account = ''): string {
  return `<!doctype html><meta charset="utf-8">
<title>Link Sudor</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;max-width:30rem;margin:12vh auto;padding:0 1.25rem;color:#151a21;background:#f6f7f9}
 h1{font-size:1.35rem;margin:0 0 .25rem} p{color:#515a69}
 label{display:block;font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;color:#7b8494;margin:1.5rem 0 .4rem}
 input{width:100%;padding:.7rem .8rem;font-size:1rem;border:1px solid #c3c9d3;border-radius:3px;background:#fff}
 button{margin-top:1.25rem;width:100%;padding:.8rem;font-size:1rem;font-weight:600;color:#fff;background:#b85c15;border:0;border-radius:3px;cursor:pointer}
 small{display:block;margin-top:1.5rem;color:#7b8494}
 .err{margin:1rem 0 0;padding:.7rem .8rem;border:1px solid #b3261e;border-radius:3px;color:#8c1d18;background:#fdf1f0}
 @media (prefers-contrast: more){input{border-color:#000}small,p{color:#000}}
</style>
<h1>Link Sudor</h1>
<p>${escapeHtml(client.name)} is asking to read your medications and location, and to answer whether today's heat is dangerous for you.</p>
${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/oauth/authorize">
  <input type="hidden" name="client_id" value="${escapeHtml(f.client_id)}">
  <input type="hidden" name="redirect_uri" value="${escapeHtml(f.redirect_uri)}">
  <input type="hidden" name="code_challenge" value="${escapeHtml(f.code_challenge)}">
  <input type="hidden" name="state" value="${escapeHtml(f.state)}">
  <label for="account">Your name</label>
  <input id="account" name="account" required autocomplete="username" placeholder="e.g. Jordan" value="${escapeHtml(account)}">
  <label for="passphrase">Passphrase</label>
  <input id="passphrase" name="passphrase" type="password" required minlength="${store.MIN_PASSPHRASE}" autocomplete="current-password">
  <button type="submit">Link</button>
</form>
<small>The first time you link a name, this sets its passphrase. After that it is asked for every time, so nobody else who types your name gets your medications. Your medications stay on this server. Sudor never sees your pharmacy or health records.</small>`;
}

/**
 * New names per address.
 *
 * A first-time link creates a credential, costs a third of a second and 64 MiB to
 * hash, and leaves behind a record whose location gets polled for ever. Creating
 * accounts is the one thing here that is both cheap to automate and expensive to
 * have automated, so it has its own limit, separate from logging in. One person
 * claims one name, once; a household behind one address may claim a few.
 * Existing accounts signing in again are not counted.
 */
const claimsPerAddress = perCaller(
  Number(process.env.SUDOR_CLAIM_BURST ?? 5),
  Number(process.env.SUDOR_CLAIMS_PER_HOUR ?? 6) / 60,
);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Dynamic clients are a development convenience, so there is a ceiling on how many are remembered. */
const MAX_DYNAMIC_CLIENTS = 200;
const registrations = perCaller(5, 1);

/** A redirect target has to be https, or plain http on this machine. Nothing else is a place to send a code. */
function okRedirect(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 300) return false;
  try {
    const u = new URL(value);
    if (u.username || u.password || u.hash) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** A page that takes a passphrase is never shown inside somebody else's page, and is never kept. */
function noFraming(res: Response): void {
  res.set('Content-Security-Policy', "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'");
  res.set('X-Frame-Options', 'DENY');
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
}

export function mountAuth(app: Express): void {
  // Read the file now. A wrong or missing key should stop the process at boot, not
  // surface as an error page the first time somebody tries to link.
  store.load();

  if (STATIC_CLIENT_ID) {
    if (STATIC_REDIRECT_URIS.length === 0) {
      // Fail loudly rather than silently accepting a client no redirect_uri
      // could ever match, which would look like it worked until Alexa+ tried
      // to actually link an account.
      throw new Error('SUDOR_CLIENT_ID is set but SUDOR_REDIRECT_URIS is empty. Set both from `alexa-ai configure-account-linking`.');
    }
    clients.set(STATIC_CLIENT_ID, { id: STATIC_CLIENT_ID, redirectUris: STATIC_REDIRECT_URIS, name: 'Alexa+' });
  }

  // ---- discovery ------------------------------------------------------
  app.get('/.well-known/oauth-protected-resource', (req, res) => {
    const origin = originOf(req);
    res.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      scopes_supported: ['sudor.read', 'sudor.write'],
      resource_documentation: 'https://github.com/nirbhay221/sudor',
    });
  });

  const asMetadata = (req: Request, res: Response) => {
    const origin = originOf(req);
    res.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      ...(STATIC_CLIENT_ID ? {} : { registration_endpoint: `${origin}/oauth/register` }),
      scopes_supported: ['sudor.read', 'sudor.write'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      // Alexa+ checks for this exact value. Without S256 linking stops here.
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  };
  app.get('/.well-known/oauth-authorization-server', asMetadata);
  app.get('/.well-known/openid-configuration', asMetadata);

  // ---- dynamic client registration ------------------------------------
  app.post('/oauth/register', (req, res) => {
    // Alexa+ does not use dynamic registration: it is given one client id and its redirect URIs out of band.
    // Once that client is configured, leaving registration open only serves somebody else, who could
    // register a client called "Alexa+" with their own redirect URI and send a customer to this server's
    // real consent page, where a correct passphrase would hand the attacker a token. So it is closed.
    if (STATIC_CLIENT_ID) {
      res.status(403).json({ error: 'access_denied', error_description: 'Dynamic client registration is not available on this server.' });
      return;
    }
    if (!registrations.allow(`ip:${req.ip ?? 'unknown'}`)) {
      res.status(429).set('Retry-After', '60').json({ error: 'slow_down', error_description: 'Too many registrations. Try again shortly.' });
      return;
    }
    const uris: unknown = req.body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every(okRedirect)) {
      res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uris must be one to five https URLs, or http on localhost.',
      });
      return;
    }
    // Bounded, oldest out first. The registered client the configuration names is never dropped.
    while (clients.size >= MAX_DYNAMIC_CLIENTS) {
      const oldest = [...clients.keys()].find((k) => k !== STATIC_CLIENT_ID);
      if (!oldest) break;
      clients.delete(oldest);
    }
    const id = `orb_${randomBytes(12).toString('hex')}`;
    // A registered name is whatever the caller typed, so it is shown as a claim and never as a fact.
    const claimed = typeof req.body?.client_name === 'string' ? req.body.client_name.replace(/[^\w .,'+-]/g, ' ').trim().slice(0, 60) : '';
    clients.set(id, {
      id,
      redirectUris: uris as string[],
      name: claimed ? `An app calling itself "${claimed}"` : 'An unnamed app',
    });
    res.status(201).json({
      client_id: id,
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  // ---- authorization ---------------------------------------------------
  app.get('/oauth/authorize', (req, res) => {
    const { client_id, redirect_uri, code_challenge, code_challenge_method, state, response_type } =
      req.query as Record<string, string | undefined>;

    const client = client_id ? clients.get(client_id) : undefined;
    if (!client || !redirect_uri || !client.redirectUris.includes(redirect_uri)) {
      // Never redirect on a bad client or redirect_uri; that is how open
      // redirectors get built.
      res.status(400).send('Unknown client, or redirect_uri does not match the one registered.');
      return;
    }
    const fail = (error: string, description: string) => {
      const u = new URL(redirect_uri);
      u.searchParams.set('error', error);
      u.searchParams.set('error_description', description);
      if (state) u.searchParams.set('state', state);
      res.redirect(u.toString());
    };
    if (response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
    if (!code_challenge) return fail('invalid_request', 'PKCE is required.');
    if ((code_challenge_method ?? 'plain') !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256.');

    noFraming(res);
    res.type('html').send(consentPage(client, { client_id: client_id!, redirect_uri, code_challenge, state: state ?? '' }));
  });

  app.post('/oauth/authorize', async (req, res) => {
    const { client_id, redirect_uri, code_challenge, state, account, passphrase } = req.body ?? {};
    const client = clients.get(client_id);
    if (!client || !client.redirectUris.includes(redirect_uri) || !code_challenge || !account) {
      res.status(400).send('Invalid authorization request.');
      return;
    }

    const name = store.normaliseName(account);
    const fields: ConsentFields = {
      client_id: String(client_id),
      redirect_uri: String(redirect_uri),
      code_challenge: String(code_challenge),
      state: String(state ?? ''),
    };
    const again = (status: number, message: string) => {
      noFraming(res);
      res.status(status).type('html').send(consentPage(client, fields, message, String(account)));
    };

    // Only a name nobody has claimed counts against the address, and only when the
    // passphrase is one that could actually claim it, so a mistyped form is free.
    if (name && !store.hasCredential(name) && String(passphrase ?? '').length >= store.MIN_PASSPHRASE) {
      if (!claimsPerAddress.allow(`ip:${req.ip ?? 'unknown'}`)) {
        res.set('Retry-After', '3600');
        return again(429, 'Too many new names have been linked from this address. Try again in an hour.');
      }
    }

    // A name alone is no longer enough. See authstore.ts for why, and for what this
    // does and does not defend against.
    const verdict = await store.claimOrVerify(name, String(passphrase ?? ''), req.ip ?? '');
    switch (verdict.kind) {
      case 'claimed':
      case 'ok':
        break;
      case 'weak':
        return again(400, verdict.reason);
      case 'locked':
        res.set('Retry-After', String(verdict.retryAfterSeconds));
        return again(429, `Too many wrong passphrases for that name. Try again in ${Math.ceil(verdict.retryAfterSeconds / 60)} minutes.`);
      case 'busy':
        res.set('Retry-After', '5');
        return again(503, 'Busy right now. Try again in a few seconds.');
      default:
        // One message for every way of being wrong, so the page cannot be used to
        // find out which names have already been claimed.
        return again(403, 'That name and passphrase did not match. If you have not linked before, choose a different name.');
    }

    const code = secret();
    codes.set(code, {
      clientId: client_id,
      redirectUri: redirect_uri,
      challenge: code_challenge,
      subject: name,
      expires: now() + CODE_TTL_MS,
    });
    const u = new URL(redirect_uri);
    u.searchParams.set('code', code);
    if (state) u.searchParams.set('state', state);
    res.redirect(u.toString());
  });

  // ---- token -----------------------------------------------------------
  app.post('/oauth/token', (req, res) => {
    expire();
    const body = req.body ?? {};
    const bad = (error: string, description: string) => res.status(400).json({ error, error_description: description });

    if (body.grant_type === 'refresh_token') {
      const presented = store.hashToken(String(body.refresh_token ?? ''));

      // A token that has already been exchanged is being shown a second time, which
      // means a copy exists. Rotation is only worth having if that is noticed.
      // RFC 9700 describes revoking everything associated with the grant, and this
      // does, because the server cannot tell which holder is the thief.
      const reused = store.spent.get(presented);
      if (reused && reused.expires >= now()) {
        const gone = store.revokeFamily(reused.subject, reused.clientId);
        console.error(`[auth] a spent refresh token was presented again; revoked ${gone} tokens for that grant.`);
        return bad('invalid_grant', 'Refresh token is unknown or expired.');
      }

      const existing = store.refresh.get(presented);
      if (!existing || existing.expires < now()) return bad('invalid_grant', 'Refresh token is unknown or expired.');
      // A refresh token belongs to the client it was issued to.
      if (body.client_id && body.client_id !== existing.clientId) {
        return bad('invalid_grant', 'Refresh token is unknown or expired.');
      }
      store.refresh.delete(presented); // rotation: one use each
      store.spent.set(presented, existing);
      return void res.json(issue(existing.subject, existing.clientId));
    }

    if (body.grant_type !== 'authorization_code') {
      return bad('unsupported_grant_type', 'Use authorization_code or refresh_token.');
    }

    const entry = codes.get(body.code);
    if (!entry) return bad('invalid_grant', 'Authorization code is unknown, expired, or already used.');
    codes.delete(body.code); // single use, deleted before any other check
    if (entry.expires < now()) return bad('invalid_grant', 'Authorization code expired.');
    if (entry.clientId !== body.client_id) return bad('invalid_grant', 'Code was issued to a different client.');
    if (entry.redirectUri !== body.redirect_uri) return bad('invalid_grant', 'redirect_uri does not match the request.');
    if (!verifyPkce(String(body.code_verifier ?? ''), entry.challenge)) {
      return bad('invalid_grant', 'PKCE verification failed.');
    }
    res.json(issue(entry.subject, entry.clientId));
  });

  function issue(subject: string, clientId: string) {
    const access = secret();
    const refresh = secret();
    store.access.set(store.hashToken(access), { subject, clientId, expires: now() + ACCESS_TTL_MS });
    store.refresh.set(store.hashToken(refresh), { subject, clientId, expires: now() + REFRESH_TTL_MS });
    store.save();
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refresh,
      scope: 'sudor.read sudor.write',
    };
  }
}

/** Test seam: forget every token and credential, as a fresh process would. */
export function resetAuthForTest(): void {
  store.resetForTest();
  codes.clear();
}

/** Test seam: register a client without going through HTTP. */
export function registerClientForTest(redirectUris: string[], name = 'test'): string {
  const id = `orb_test_${randomBytes(6).toString('hex')}`;
  clients.set(id, { id, redirectUris, name });
  return id;
}
