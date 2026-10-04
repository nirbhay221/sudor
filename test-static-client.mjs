// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * The fix this file tests: Amazon's own account-linking docs say Alexa+
 * "supports only the Authorization Code Grant" and "Dynamic Client
 * Registration (DCR) isn't supported." The developer picks a client_id,
 * registers it out of band via `alexa-ai configure-account-linking`, and gets
 * back a SET of Alexa redirect URIs to accept, not one. This is the shape
 * DCR does not produce, so it needed its own path and its own test, not just
 * "the old DCR tests still pass."
 */
process.env.SUDOR_AUTH_DATA = './data/test-static-client-auth.json';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pkceS256 } from './dist/auth.js';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const PORT = 8795;
const BASE = `http://127.0.0.1:${PORT}`;
const CLIENT_ID = 'sudor-alexa-addon';
const REDIRECT_A = 'https://layla.amazon.com/api/skill/link/M1TEST_A';
const REDIRECT_B = 'https://pitangui.amazon.com/api/skill/link/M1TEST_B'; // a second region

async function waitForBoot() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not start');
}

console.log('\nNo redirect URIs configured: the server must refuse to boot rather than link a broken client');
{
  const bad = spawn(process.execPath, ['dist/server.js'], {
    env: { ...process.env, PORT: '8792', SUDOR_AUTH: 'on', SUDOR_CLIENT_ID: CLIENT_ID, SUDOR_DATA: './data/test-static-bad-sudor.json' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  bad.stderr.on('data', (d) => { stderr += d; });
  const exitCode = await new Promise((resolve) => bad.on('exit', resolve));
  check('refuses to start rather than silently accepting an unmatchable client', exitCode !== 0);
  check('the error names which two variables to set together',
    /SUDOR_CLIENT_ID/.test(stderr) && /SUDOR_REDIRECT_URIS/.test(stderr), stderr.slice(0, 200));
}

console.log('\nWith both variables set, the static client is pre-registered at boot, no DCR call needed');
const server = spawn(process.execPath, ['dist/server.js'], {
  env: {
    ...process.env, PORT: String(PORT), SUDOR_AUTH: 'on',
    SUDOR_CLIENT_ID: CLIENT_ID, SUDOR_REDIRECT_URIS: `${REDIRECT_A},${REDIRECT_B}`,
    SUDOR_DATA: './data/test-static-good-sudor.json',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const stop = () => { try { server.kill(); } catch {} };
process.on('exit', stop);

try {
  await waitForBoot();

  const verifier = randomBytes(40).toString('base64url');
  const challenge = pkceS256(verifier);

  const authorizeUrl = (redirectUri) =>
    `${BASE}/oauth/authorize?` + new URLSearchParams({
      response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri,
      code_challenge: challenge, code_challenge_method: 'S256', state: 's1',
    });

  console.log('\nNever having called /oauth/register at all, using only the pre-registered client');
  const page = await fetch(authorizeUrl(REDIRECT_A));
  check('the consent page renders for a client that was never dynamically registered', page.status === 200);

  const consent = await fetch(`${BASE}/oauth/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_A, code_challenge: challenge, state: 's1', account: 'jordan', passphrase: 'correct horse battery' }),
  });
  const code = new URL(consent.headers.get('location')).searchParams.get('code');
  check('consent issues a code for the static client', !!code);

  const tok = await (await fetch(`${BASE}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: CLIENT_ID, redirect_uri: REDIRECT_A, code_verifier: verifier }),
  })).json();
  check('token exchange succeeds against the static client', typeof tok.access_token === 'string', JSON.stringify(tok));

  console.log("\nAlexa's second-region redirect URI, from the same set, must also be accepted");
  const authorizeUrl2 = (redirectUri) =>
    `${BASE}/oauth/authorize?` + new URLSearchParams({
      response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri,
      code_challenge: challenge, code_challenge_method: 'S256', state: 's2',
    });
  const consent2 = await fetch(`${BASE}/oauth/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_B, code_challenge: challenge, state: 's2', account: 'jordan', passphrase: 'correct horse battery' }),
  });
  check("a second, different registered redirect_uri is accepted, not just the first one",
    consent2.status === 302 && new URL(consent2.headers.get('location')).searchParams.get('code'), String(consent2.status));

  console.log('\nA redirect_uri outside the configured set is still refused, static or not');
  const evil = await fetch(authorizeUrl2('https://evil.example/steal'), { redirect: 'manual' });
  check('an unlisted redirect_uri is rejected even for the static client', evil.status === 400, String(evil.status));

  console.log('\nWith the real client configured, nobody else can register one');
  const regRes = await fetch(`${BASE}/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://evil.example/callback'], client_name: 'Alexa+' }),
  });
  check('dynamic registration is refused, so a look-alike "Alexa+" client cannot be created', regRes.status === 403, String(regRes.status));
  const meta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  check('and the metadata does not advertise a registration endpoint that is closed', !('registration_endpoint' in meta), JSON.stringify(Object.keys(meta)));
} finally {
  stop();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
