/**
 * Two doors, because two different things were sharing one.
 *
 * The public demo page calls /mcp anonymously. With auth on, an anonymous call was a
 * 401, so the page could not work, so auth stayed off on the public endpoint, and
 * the real accounts behind it were exactly as open as the demo. The conflict was
 * real and the answer was to stop pretending it was one door.
 *
 * What is pinned here is that opening the sandbox door did not loosen the other:
 * an anonymous caller reaches a sandbox of their own making and nothing else, a
 * guessable id gets nowhere, turning the demo off closes the anonymous door
 * entirely, and a demo header can never stand in for, or override, a linked account.
 *
 * Runs a real server process with auth on.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const DIR = './data/test-demo-door';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

const REDIRECT = 'https://pitangui.amazon.com/api/skill/link/TEST';
const CLIENT = 'sudor-test-client';
const PASS = 'correct horse battery';

const start = async (port, extra = {}) => {
  const child = spawn(process.execPath, ['dist/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      SUDOR_DATA: `${DIR}/people-${port}.json`,
      SUDOR_AUTH_DATA: `${DIR}/auth-${port}.json`,
      SUDOR_AUTH: 'on',
      SUDOR_CLIENT_ID: CLIENT,
      SUDOR_REDIRECT_URIS: REDIRECT,
      ...extra,
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i += 1) {
    try { await fetch(`${base}/health`); return { child, base }; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('server did not start');
};

const rpc = (base, method, params, headers = {}) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

const text = async (res) => {
  const body = await res.text();
  const line = body.split('\n').find((l) => l.startsWith('data: ')) ?? body;
  try { return JSON.parse(line.replace(/^data: /, '')); } catch { return { raw: body }; }
};

const call = async (base, name, args, headers) => {
  const res = await rpc(base, 'tools/call', { name, arguments: args }, headers);
  const j = await text(res);
  return { status: res.status, text: j.result?.content?.[0]?.text ?? '', raw: j };
};

const DEMO_A = randomBytes(16).toString('hex');
const DEMO_B = randomBytes(16).toString('hex');

const a = await start(8871);
try {
  console.log('\nAuth on: an anonymous call with no identity is refused');
  {
    const res = await rpc(a.base, 'tools/list', {});
    check('no token and no demo id is a 401', res.status === 401, String(res.status));
    check('and it says where to link', (res.headers.get('www-authenticate') ?? '').includes('resource_metadata'));
    check('/health still answers', (await fetch(`${a.base}/health`)).status === 200);
  }

  console.log('\nThe sandbox door works, with auth still on');
  {
    const res = await rpc(a.base, 'tools/list', {}, { 'x-sudor-demo': DEMO_A });
    check('a valid demo id is let in', res.status === 200, String(res.status));
    const health = await (await fetch(`${a.base}/health`)).json();
    check('while /health reports auth is on', String(health.auth).includes('oauth'), String(health.auth));
  }

  console.log('\nA guessable id gets nowhere');
  {
    for (const weak of ['abcdefgh', 'd1a2b3c4d5e6', 'a'.repeat(31), 'A'.repeat(32), `${'a'.repeat(31)}!`, `${DEMO_A}00`]) {
      const res = await rpc(a.base, 'tools/list', {}, { 'x-sudor-demo': weak });
      check(`"${weak.slice(0, 18)}" is refused`, res.status === 401, String(res.status));
    }
  }

  console.log('\nTwo visitors never see each other');
  {
    await call(a.base, 'medication', { action: 'add', name: 'metoprolol' }, { 'x-sudor-demo': DEMO_A });
    const mine = await call(a.base, 'my_profile', {}, { 'x-sudor-demo': DEMO_A });
    const theirs = await call(a.base, 'my_profile', {}, { 'x-sudor-demo': DEMO_B });
    check('visitor A sees their medication', /metoprolol|beta/i.test(mine.text), mine.text.slice(0, 100));
    check('visitor B does not', !/metoprolol|beta/i.test(theirs.text), theirs.text.slice(0, 100));
  }

  console.log('\nA demo header can never stand in for, or override, a linked account');
  {
    // Link a real account through the real flow.
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const linked = await fetch(`${a.base}/oauth/authorize`, {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams({ client_id: CLIENT, redirect_uri: REDIRECT, code_challenge: challenge, state: 's', account: 'jordan', passphrase: PASS }),
    });
    const code = new URL(linked.headers.get('location') ?? 'http://x/?').searchParams.get('code');
    check('the account linked', linked.status === 302 && !!code, String(linked.status));

    const tok = await (await fetch(`${a.base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: CLIENT, redirect_uri: REDIRECT }),
    })).json();
    const bearer = { authorization: `Bearer ${tok.access_token}` };

    // Write a distinctive medication with BOTH a token and a demo header.
    await call(a.base, 'medication', { action: 'add', name: 'sertraline' }, { ...bearer, 'x-sudor-demo': DEMO_B });

    const asAccount = await call(a.base, 'my_profile', {}, bearer);
    const asDemoOnly = await call(a.base, 'my_profile', {}, { 'x-sudor-demo': DEMO_B });
    check('the write went to the account', /sertraline|ssri/i.test(asAccount.text), asAccount.text.slice(0, 100));
    check('not to the demo id that rode along with it', !/sertraline|ssri/i.test(asDemoOnly.text), asDemoOnly.text.slice(0, 100));

    // And the reverse: the account's data is unreachable from the sandbox.
    const stranger = await call(a.base, 'my_profile', {}, { 'x-sudor-demo': randomBytes(16).toString('hex') });
    check('a fresh demo id cannot see the account', !/sertraline|ssri|metoprolol/i.test(stranger.text));
  }
} finally {
  a.child.kill();
}

const b = await start(8872, { SUDOR_DEMO: 'off' });
try {
  console.log('\nWith the demo switched off there is no anonymous door at all');
  {
    const res = await rpc(b.base, 'tools/list', {}, { 'x-sudor-demo': DEMO_A });
    check('a well formed demo id is refused', res.status === 401, String(res.status));
    const none = await rpc(b.base, 'tools/list', {});
    check('and so is nothing', none.status === 401, String(none.status));
  }
} finally {
  b.child.kill();
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
