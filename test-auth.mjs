// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * OAuth 2.1 checks, run against a real server with SUDOR_AUTH=on.
 *
 * These are the steps Alexa+ walks during account linking, in order: discover
 * the metadata, get told to link, register, authorize with PKCE, exchange the
 * code, then call the tool. Each one is also a way to be wrong quietly, so the
 * failure cases are tested too: plain PKCE, a wrong verifier, a replayed code,
 * a replayed refresh token.
 */

process.env.SUDOR_AUTH_DATA = './data/test-auth-auth.json';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { pkceS256, verifyPkce } from './dist/auth.js';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;

console.log('\nPKCE maths');
const verifier = randomBytes(40).toString('base64url');
const challenge = pkceS256(verifier);
check('S256 challenge matches RFC 7636', challenge === createHash('sha256').update(verifier).digest('base64url'));
check('correct verifier passes', verifyPkce(verifier, challenge));
check('wrong verifier fails', !verifyPkce(randomBytes(40).toString('base64url'), challenge));
check('plain method is refused, OAuth 2.1 dropped it', !verifyPkce(verifier, verifier, 'plain'));
check('a too-short verifier is refused', !verifyPkce('abc', pkceS256('abc')));

const server = spawn(process.execPath, ['dist/server.js'], {
  env: { ...process.env, PORT: String(PORT), SUDOR_AUTH: 'on', SUDOR_DATA: './data/test-auth-sudor.json' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const stop = () => { try { server.kill(); } catch {} };
process.on('exit', stop);

async function waitForBoot() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not start');
}

try {
  const health = await waitForBoot();
  console.log('\nServer');
  check('reports auth is on', health.auth?.startsWith('oauth2.1'), JSON.stringify(health.auth));

  console.log('\nDiscovery, what a client can read before it has any token');
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
  check('protected resource names the MCP endpoint', prm.resource === `${BASE}/mcp`, prm.resource);
  check('...and points at its authorization server', prm.authorization_servers?.[0] === BASE);
  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  check('advertises S256, the value Alexa+ checks for',
    as.code_challenge_methods_supported?.includes('S256'), JSON.stringify(as.code_challenge_methods_supported));
  check('advertises the authorization code grant', as.grant_types_supported?.includes('authorization_code'));

  console.log('\nAn unlinked call is refused, and says where to link');
  const denied = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  check('401 rather than a silent failure', denied.status === 401, String(denied.status));
  check('WWW-Authenticate carries the metadata URL',
    (denied.headers.get('www-authenticate') ?? '').includes('resource_metadata='),
    denied.headers.get('www-authenticate') ?? 'missing');

  console.log('\nRegistration and authorization');
  const redirectUri = 'https://client.example/callback';
  const reg = await (await fetch(`${BASE}/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: 'Test client' }),
  })).json();
  check('dynamic registration returns a client id', typeof reg.client_id === 'string', JSON.stringify(reg));

  const authorizeUrl = (params) =>
    `${BASE}/oauth/authorize?` + new URLSearchParams({
      response_type: 'code', client_id: reg.client_id, redirect_uri: redirectUri,
      code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', ...params,
    });

  const plain = await fetch(authorizeUrl({ code_challenge_method: 'plain' }), { redirect: 'manual' });
  check('plain PKCE is rejected at the authorize step',
    (plain.headers.get('location') ?? '').includes('error=invalid_request'), plain.headers.get('location') ?? '');

  const wrongRedirect = await fetch(authorizeUrl({ redirect_uri: 'https://evil.example/steal' }), { redirect: 'manual' });
  check('an unregistered redirect_uri never redirects', wrongRedirect.status === 400, String(wrongRedirect.status));

  const unticked = await fetch(`${BASE}/oauth/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: reg.client_id, redirect_uri: redirectUri, code_challenge: challenge,
      state: 'xyz', account: 'Red River', passphrase: 'correct horse battery',
    }),
  });
  check('without the consent box ticked, nothing is linked', unticked.status === 400 && !unticked.headers.get('location'), String(unticked.status));

  const consent = await fetch(`${BASE}/oauth/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: reg.client_id, redirect_uri: redirectUri, code_challenge: challenge,
      state: 'xyz', account: 'Red River', passphrase: 'correct horse battery', consent: 'yes',
    }),
  });
  const back = new URL(consent.headers.get('location') ?? 'https://x.invalid');
  const code = back.searchParams.get('code');
  check('consent returns a code and preserves state', !!code && back.searchParams.get('state') === 'xyz');

  console.log('\nToken exchange');
  const tokenReq = (body) => fetch(`${BASE}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const wrong = await (await tokenReq({
    grant_type: 'authorization_code', code, client_id: reg.client_id,
    redirect_uri: redirectUri, code_verifier: randomBytes(40).toString('base64url'),
  })).json();
  check('a wrong verifier is rejected', wrong.error === 'invalid_grant', JSON.stringify(wrong));

  const consent2 = await fetch(`${BASE}/oauth/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: reg.client_id, redirect_uri: redirectUri, code_challenge: challenge,
      state: 'xyz', account: 'Red River', passphrase: 'correct horse battery', consent: 'yes',
    }),
  });
  const code2 = new URL(consent2.headers.get('location')).searchParams.get('code');
  const tok = await (await tokenReq({
    grant_type: 'authorization_code', code: code2, client_id: reg.client_id,
    redirect_uri: redirectUri, code_verifier: verifier,
  })).json();
  check('the right verifier gets an access token', typeof tok.access_token === 'string', JSON.stringify(tok));

  const replay = await (await tokenReq({
    grant_type: 'authorization_code', code: code2, client_id: reg.client_id,
    redirect_uri: redirectUri, code_verifier: verifier,
  })).json();
  check('a code cannot be replayed', replay.error === 'invalid_grant', JSON.stringify(replay));

  console.log('\nThe token actually opens the door');
  const ok = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${tok.access_token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }),
  });
  check('a linked call is accepted', ok.status === 200, String(ok.status));

  console.log('\nRefresh tokens rotate');
  const refreshed = await (await tokenReq({ grant_type: 'refresh_token', refresh_token: tok.refresh_token })).json();
  check('refresh returns a new access token', typeof refreshed.access_token === 'string');
  check('...and a different one', refreshed.access_token !== tok.access_token);
  const reused = await (await tokenReq({ grant_type: 'refresh_token', refresh_token: tok.refresh_token })).json();
  check('the old refresh token is dead after use', reused.error === 'invalid_grant', JSON.stringify(reused));
} finally {
  stop();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
