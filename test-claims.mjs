// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * Creating accounts is cheap to automate and expensive to have automated.
 *
 * A first-time link costs a third of a second and 64 MiB to hash, and leaves a record
 * whose location is polled for ever. So it has a limit of its own, per address, that
 * does not touch anybody signing in to a name they already hold.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const DIR = './data/test-claims';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.SUDOR_AUTH_DATA = `${DIR}/auth.json`;
process.env.SUDOR_CLAIM_BURST = '3';
process.env.SUDOR_CLAIMS_PER_HOUR = '1';
delete process.env.SUDOR_DATA_KEY;

const express = createRequire(import.meta.url)('express');
const auth = await import('./dist/auth.js');
const authstore = await import('./dist/authstore.js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
auth.mountAuth(app);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const REDIRECT = 'https://pitangui.amazon.com/api/skill/link/TEST';
const clientId = auth.registerClientForTest([REDIRECT], 'Alexa+');
const PASS = 'correct horse battery';

const link = async (name, passphrase) => {
  const verifier = randomBytes(48).toString('base64url');
  const res = await fetch(`${base}/oauth/authorize`, {
    method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: auth.pkceS256(verifier), state: 's', account: name, passphrase }),
  });
  return { res, code: res.headers.get('location') ? new URL(res.headers.get('location')).searchParams.get('code') : null, html: res.status < 300 ? '' : await res.text() };
};

console.log('\nThe fourth new name from one address is refused');
{
  const r = [];
  for (let i = 0; i < 3; i += 1) r.push(await link(`household-${i}`, PASS));
  check('three new names are allowed', r.every((x) => x.code !== null), r.map((x) => x.res.status).join(','));

  const fourth = await link('household-3', PASS);
  check('the fourth is refused', fourth.res.status === 429, String(fourth.res.status));
  check('with a reason a person can act on', fourth.html.includes('Try again in an hour'), fourth.html.slice(0, 50));
  check('and Retry-After', Number(fourth.res.headers.get('retry-after')) > 0);
  check('and the refused name was not claimed', authstore.hasCredential('household-3') === false);
  check('while the allowed ones were', authstore.hasCredential('household-0') && authstore.hasCredential('household-2'));
}

console.log('\nSigning in to a name you already hold is never counted');
{
  let worked = 0;
  for (let i = 0; i < 6; i += 1) {
    if ((await link('household-0', PASS)).code !== null) worked += 1;
  }
  check('six sign-ins to an existing name all worked', worked === 6, String(worked));
}

console.log('\nA mistyped form does not spend the allowance');
{
  const short = await link('household-9', 'short');
  check('a too-short passphrase is a 400, not a 429', short.res.status === 400, String(short.res.status));
  const empty = await link('', PASS);
  check('an empty name is not a 429 either', empty.res.status !== 429, String(empty.res.status));
}

server.close();
rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
