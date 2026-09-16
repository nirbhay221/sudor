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

const CODE_TTL_MS = 60_000;
const ACCESS_TTL_MS = 60 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;

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
type Token = { subject: string; clientId: string; expires: number };

const clients = new Map<string, Client>();
const codes = new Map<string, Code>();
const accessTokens = new Map<string, Token>();
const refreshTokens = new Map<string, Token>();

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
  const t = now();
  for (const [k, v] of codes) if (v.expires < t) codes.delete(k);
  for (const [k, v] of accessTokens) if (v.expires < t) accessTokens.delete(k);
  for (const [k, v] of refreshTokens) if (v.expires < t) refreshTokens.delete(k);
}

/** The subject a request is acting as, or null when it carries no valid token. */
export function subjectOf(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  expire();
  const token = accessTokens.get(header.slice(7).trim());
  return token && token.expires > now() ? token.subject : null;
}

/**
 * Gate for /mcp. A 401 has to name where the metadata lives, otherwise the
 * client has no way to discover the authorization server and start linking.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!AUTH_ON) return next();
  if (subjectOf(req)) return next();
  res
    .status(401)
    .set(
      'WWW-Authenticate',
      `Bearer realm="sudor", error="invalid_token", resource_metadata="${originOf(req)}/.well-known/oauth-protected-resource"`,
    )
    .json({ error: 'invalid_token', error_description: 'Link your account to use Sudor.' });
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function mountAuth(app: Express): void {
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
      registration_endpoint: `${origin}/oauth/register`,
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
    const uris: unknown = req.body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === 'string')) {
      res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required.' });
      return;
    }
    const id = `orb_${randomBytes(12).toString('hex')}`;
    clients.set(id, {
      id,
      redirectUris: uris as string[],
      name: typeof req.body?.client_name === 'string' ? req.body.client_name : 'unnamed client',
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

    res.type('html').send(`<!doctype html><meta charset="utf-8">
<title>Link Sudor</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;max-width:30rem;margin:12vh auto;padding:0 1.25rem;color:#151a21;background:#f6f7f9}
 h1{font-size:1.35rem;margin:0 0 .25rem} p{color:#515a69}
 label{display:block;font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;color:#7b8494;margin:1.5rem 0 .4rem}
 input{width:100%;padding:.7rem .8rem;font-size:1rem;border:1px solid #c3c9d3;border-radius:3px;background:#fff}
 button{margin-top:1.25rem;width:100%;padding:.8rem;font-size:1rem;font-weight:600;color:#fff;background:#b85c15;border:0;border-radius:3px;cursor:pointer}
 small{display:block;margin-top:1.5rem;color:#7b8494}
</style>
<h1>Link Sudor</h1>
<p>${escapeHtml(client.name)} is asking to read your medications and location, and to answer whether today's heat is dangerous for you.</p>
<form method="post" action="/oauth/authorize">
  <input type="hidden" name="client_id" value="${escapeHtml(client_id!)}">
  <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}">
  <input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge)}">
  <input type="hidden" name="state" value="${escapeHtml(state ?? '')}">
  <label for="account">Your name</label>
  <input id="account" name="account" required autocomplete="off" placeholder="e.g. Jordan">
  <button type="submit">Link</button>
</form>
<small>Your medications stay on this server. Sudor never sees your pharmacy or health records.</small>`);
  });

  app.post('/oauth/authorize', (req, res) => {
    const { client_id, redirect_uri, code_challenge, state, account } = req.body ?? {};
    const client = clients.get(client_id);
    if (!client || !client.redirectUris.includes(redirect_uri) || !code_challenge || !account) {
      res.status(400).send('Invalid authorization request.');
      return;
    }
    const code = secret();
    codes.set(code, {
      clientId: client_id,
      redirectUri: redirect_uri,
      challenge: code_challenge,
      subject: String(account).trim().toLowerCase().slice(0, 64),
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
      const existing = refreshTokens.get(body.refresh_token);
      if (!existing || existing.expires < now()) return bad('invalid_grant', 'Refresh token is unknown or expired.');
      refreshTokens.delete(body.refresh_token); // rotation: one use each
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
    accessTokens.set(access, { subject, clientId, expires: now() + ACCESS_TTL_MS });
    refreshTokens.set(refresh, { subject, clientId, expires: now() + REFRESH_TTL_MS });
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refresh,
      scope: 'sudor.read sudor.write',
    };
  }
}

/** Test seam: register a client without going through HTTP. */
export function registerClientForTest(redirectUris: string[], name = 'test'): string {
  const id = `orb_test_${randomBytes(6).toString('hex')}`;
  clients.set(id, { id, redirectUris, name });
  return id;
}
