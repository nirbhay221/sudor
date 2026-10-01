/**
 * Linking an account, when the record behind the name is somebody's prescriptions.
 *
 * Before this, the consent page asked for a name and nothing else, and the name
 * became the subject every tool scoped its data to. Typing `jordan` made you
 * `acct:jordan`, with Jordan's medication list, address and family email. The code
 * called the page a stub, and stubs are fine until the thing behind them is a
 * health record.
 *
 * So the tests that matter are adversarial ones: a name alone is refused, a wrong
 * passphrase is refused, a locked name is refused *cheaply*, a replayed refresh
 * token takes the whole grant down with it, and a copy of the file on disk is
 * useless to whoever holds it.
 *
 * Run in process so a restart can be simulated by dropping every in-memory map and
 * reading the file again, which is exactly what a deploy does.
 */
import { mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const DIR = './data/test-linking';
const FILE = `${DIR}/auth.json`;
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.SUDOR_AUTH_DATA = FILE;
// Many names are claimed from one address here; the limit has its own test file.
process.env.SUDOR_CLAIM_BURST = '10000';
delete process.env.SUDOR_DATA_KEY;
delete process.env.SUDOR_DATA_KEY_PREVIOUS;

const express = createRequire(import.meta.url)('express');
const auth = await import('./dist/auth.js');
const authstore = await import('./dist/authstore.js');
const vault = await import('./dist/vault.js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
auth.mountAuth(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const REDIRECT = 'https://pitangui.amazon.com/api/skill/link/TEST';
const clientId = auth.registerClientForTest([REDIRECT], 'Alexa+');
const otherClient = auth.registerClientForTest([REDIRECT], 'Somebody else');
const PASS = 'correct horse battery';

const verifierOf = () => randomBytes(48).toString('base64url');

/** Walk the consent form. Returns the response, and the code when one was issued. */
const link = async (name, passphrase, client = clientId, verifier = verifierOf()) => {
  const body = new URLSearchParams({
    client_id: client, redirect_uri: REDIRECT, code_challenge: auth.pkceS256(verifier), state: 's1', account: name,
  });
  if (passphrase !== undefined) body.set('passphrase', passphrase);
  const t0 = Date.now();
  const res = await fetch(`${base}/oauth/authorize`, { method: 'POST', body, redirect: 'manual' });
  const ms = Date.now() - t0;
  const loc = res.headers.get('location');
  const code = loc ? new URL(loc).searchParams.get('code') : null;
  return { res, code, verifier, ms, html: res.status >= 300 && res.status < 400 ? '' : await res.text() };
};

const exchange = async (code, verifier, client = clientId) => {
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client, redirect_uri: REDIRECT }),
  });
  return { status: res.status, body: await res.json() };
};

const refreshWith = async (token, client) => {
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: token, ...(client ? { client_id: client } : {}) }),
  });
  return { status: res.status, body: await res.json() };
};

const who = (token) => auth.subjectOf({ headers: { authorization: `Bearer ${token}` } });
const restart = () => { authstore.resetForTest(); };

console.log('\nA name alone no longer links');
{
  const r = await link('jordan', undefined);
  check('no passphrase is refused', r.res.status === 400, String(r.res.status));
  check('the page is shown again, not a redirect', r.html.includes('Link Sudor'));
  check('and no code was issued', r.code === null);

  const short = await link('jordan', 'short');
  check('a short passphrase is refused', short.res.status === 400, String(short.res.status));
  check('it says how long one must be', short.html.includes('at least 8'), short.html.slice(0, 40));

  const same = await link('jordan', 'jordan');
  check('a passphrase equal to the name is refused', same.res.status === 400);
  check('and nothing was claimed by any of those', !authstore.hasCredential('jordan'));
}

console.log('\nThe first link claims the name, and the passphrase is then required');
{
  const first = await link('jordan', PASS);
  check('the first link succeeds', first.res.status === 302 && first.code !== null, String(first.res.status));
  check('and the name now has a credential', authstore.hasCredential('jordan'));

  const again = await link('jordan', PASS);
  check('the right passphrase links again', again.res.status === 302 && again.code !== null);

  const wrong = await link('jordan', 'not the right one');
  check('a wrong passphrase is refused', wrong.res.status === 403, String(wrong.res.status));
  check('with no code', wrong.code === null);

  const impostor = await link('Jordan ', 'an impostor guess');
  check('"Jordan " is the same person as "jordan", and is refused too', impostor.res.status === 403, String(impostor.res.status));
  const rightOnNormalised = await link('  JORDAN', PASS);
  check('the right passphrase works under the normalised name', rightOnNormalised.code !== null);
}

console.log('\nThe refusal page keeps the OAuth parameters, and says nothing about who exists');
{
  const wrong = await link('jordan', 'still not right');
  check('the hidden fields survive a refusal', wrong.html.includes('name="code_challenge"') && wrong.html.includes(clientId), wrong.html.slice(0, 60));
  check('the name the person typed is kept', wrong.html.includes('value="jordan"'));

  // A taken name and a free one must be indistinguishable to somebody probing.
  const takenWrong = await link('jordan', 'probe probe probe');
  const takenShort = await link('jordan', 'x');
  const freeShort = await link('somebody-unclaimed', 'x');
  check('a short passphrase gets the same message for a taken name and a free one',
    takenShort.html.includes('at least 8') && freeShort.html.includes('at least 8'));
  check('so a short probe cannot list who has linked', takenShort.res.status === freeShort.res.status);
  check('a wrong long passphrase gives a generic refusal', takenWrong.html.includes('did not match'));
  check('one that never names an existing account', !takenWrong.html.toLowerCase().includes('already'));
}

console.log('\nHammering a name locks it, and a locked name costs the server almost nothing');
{
  authstore.resetForTest();
  const claim = await link('morgan', PASS);
  check('morgan claims a name', claim.code !== null);

  const timings = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await link('morgan', `wrong guess number ${i}`);
    timings.push(r.ms);
    check(`wrong guess ${i + 1} is refused`, r.res.status === 403 || r.res.status === 429, String(r.res.status));
  }
  const slowHash = Math.max(...timings);

  const locked = await link('morgan', PASS);
  check('after five failures even the right passphrase is refused', locked.res.status === 429, String(locked.res.status));
  check('it says to wait', locked.html.includes('minutes'), locked.html.slice(0, 60));
  check('and carries Retry-After', Number(locked.res.headers.get('retry-after')) > 0);
  check('the lock is cheap: no hash was computed', locked.ms < slowHash / 2, `${locked.ms}ms vs a ${slowHash}ms hash`);

  const other = await link('taylor', PASS);
  check('a different name is unaffected', other.code !== null);
}

console.log('\nA burst of first-time claims cannot exhaust memory');
{
  authstore.resetForTest();
  const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => link(`burst-${i}`, PASS)));
  const statuses = burst.map((b) => b.res.status);
  const ok = statuses.filter((s) => s === 302).length;
  const busy = statuses.filter((s) => s === 503).length;
  check('some were served', ok >= 1, statuses.join(','));
  check('the rest were told to come back, without allocating', busy >= 1, statuses.join(','));
  check('nothing else happened', ok + busy === 6, statuses.join(','));
}

console.log('\nTokens persist across a restart, and are never written down');
{
  authstore.resetForTest(); rmSync(FILE, { force: true });
  const l = await link('riley', PASS);
  const t = await exchange(l.code, l.verifier);
  const { access_token: a1, refresh_token: r1 } = t.body;
  check('a token pair was issued', t.status === 200 && a1 && r1);
  check('the access token identifies riley', who(a1) === 'riley');

  const onDisk = readFileSync(FILE, 'utf8');
  check('the raw access token is not in the file', !onDisk.includes(a1));
  check('the raw refresh token is not in the file', !onDisk.includes(r1));
  check('the passphrase is not in the file', !onDisk.includes(PASS));
  check('what is there is a hash', onDisk.includes(authstore.hashToken(a1)));
  check('the passphrase is stored as a scrypt hash at the OWASP cost', onDisk.includes('"N": 65536') || onDisk.includes('"N":65536'));

  restart(); // a deploy
  check('after a restart the same access token still works', who(a1) === 'riley');
  const refreshed = await refreshWith(r1, clientId);
  check('and the refresh token still refreshes', refreshed.status === 200 && refreshed.body.access_token, String(refreshed.status));

  restart();
  check('the new pair survives a second restart', who(refreshed.body.access_token) === 'riley');
  check('an unknown token is nobody', who('not-a-token') === null);
}

console.log('\nA spent refresh token that turns up again takes the whole grant with it');
{
  authstore.resetForTest(); rmSync(FILE, { force: true });
  const l = await link('sam', PASS);
  const first = (await exchange(l.code, l.verifier)).body;

  const second = await refreshWith(first.refresh_token, clientId);
  check('the first refresh works', second.status === 200);
  check('and the new access token works', who(second.body.access_token) === 'sam');

  // Somebody who copied the original token tries it now.
  const replay = await refreshWith(first.refresh_token, clientId);
  check('a replayed refresh token is refused', replay.status === 400, String(replay.status));
  check('it looks identical to an unknown one', replay.body.error === 'invalid_grant');
  check('and it revoked the legitimate client access token too', who(second.body.access_token) === null);

  const third = await refreshWith(second.body.refresh_token, clientId);
  check('and the legitimate refresh token', third.status === 400, String(third.status));

  // Reuse detection survives a restart, or a deploy would be a way to wipe it.
  const l2 = await link('sam', PASS);
  const pair = (await exchange(l2.code, l2.verifier)).body;
  await refreshWith(pair.refresh_token, clientId);
  restart();
  const replay2 = await refreshWith(pair.refresh_token, clientId);
  check('a replay after a restart is still caught', replay2.status === 400);
}

console.log('\nA refresh token belongs to the client it was issued to');
{
  authstore.resetForTest(); rmSync(FILE, { force: true });
  const l = await link('avery', PASS);
  const pair = (await exchange(l.code, l.verifier)).body;
  const stolen = await refreshWith(pair.refresh_token, otherClient);
  check('presenting it as another client is refused', stolen.status === 400, String(stolen.status));
  const rightful = await refreshWith(pair.refresh_token, clientId);
  check('and that attempt did not consume it', rightful.status === 200, String(rightful.status));
}

console.log('\nSealed at rest when a key is configured');
{
  authstore.resetForTest(); rmSync(FILE, { force: true });
  const keyA = randomBytes(32).toString('base64');
  const keyB = randomBytes(32).toString('base64');
  process.env.SUDOR_DATA_KEY = keyA; vault.resetForTest();

  const l = await link('quinn', PASS);
  const pair = (await exchange(l.code, l.verifier)).body;
  const sealed = readFileSync(FILE, 'utf8');
  check('the auth file is an envelope', vault.looksSealed(sealed));
  check('the subject name is not visible', !sealed.includes('quinn'));
  check('nor the token hash', !sealed.includes(authstore.hashToken(pair.access_token)));

  restart();
  check('it opens again under the same key', who(pair.access_token) === 'quinn');

  // The wrong key must refuse and leave the file exactly as it was.
  process.env.SUDOR_DATA_KEY = keyB; vault.resetForTest(); restart();
  let code = null;
  try { authstore.load(); } catch (e) { code = e.code; }
  check('the wrong key refuses to load', code === 'unknown_key', String(code));
  check('the file is byte for byte unchanged', readFileSync(FILE, 'utf8') === sealed);
  let wrote = false;
  try { authstore.save(); wrote = true; } catch { /* expected */ }
  check('and a save after that refusal refuses too', wrote === false);
  check('so nothing has been overwritten', readFileSync(FILE, 'utf8') === sealed);

  process.env.SUDOR_DATA_KEY = keyA; vault.resetForTest(); restart();
  check('the right key gets the grant back', who(pair.access_token) === 'quinn');
  delete process.env.SUDOR_DATA_KEY; vault.resetForTest();
}

console.log('\nA damaged auth file is set aside and accounts simply link again');
{
  authstore.resetForTest(); rmSync(FILE, { force: true });
  const damaged = '{"credentials": {"half a';
  writeFileSync(FILE, damaged);
  restart();
  authstore.load();
  check('the process carries on with nothing', authstore.status().credentials === 0);
  const aside = readdirSync(DIR).filter((f) => f.includes('corrupt'));
  check('the damaged file was set aside', aside.length === 1, readdirSync(DIR).join(','));
  check('with every byte intact', aside.length === 1 && readFileSync(`${DIR}/${aside[0]}`, 'utf8') === damaged);

  const l = await link('jules', PASS);
  check('and a new link works normally', l.code !== null);
  check('without disturbing the evidence', readFileSync(`${DIR}/${aside[0]}`, 'utf8') === damaged);
}

server.close();
rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
