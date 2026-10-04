// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * Sealing health data, and what happens when it will not open.
 *
 * The cipher is the easy part and is mostly Node's. The tests that matter are the
 * ones about failure, because the loader this replaced had a line that read
 * `catch { cache = {} }`: a file that would not parse became an empty database, and
 * the next ordinary write overwrote the unreadable file with the empty one. That
 * turned corruption into silent deletion of every person's record.
 *
 * Encryption makes that worse rather than better, because a wrong key is now an
 * ordinary operator mistake and "wrong key" looks exactly like "corrupt file" to a
 * loader that swallows the error. So the two are pinned apart here, and in both
 * cases the file on disk must be provably untouched.
 */
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const DIR = './data/test-vault';
const FILE = `${DIR}/people.json`;
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.SUDOR_DATA = FILE;

const keyA = randomBytes(32).toString('base64');
const keyB = randomBytes(32).toString('base64');
const setKey = (current, previous = '') => {
  if (current) process.env.SUDOR_DATA_KEY = current; else delete process.env.SUDOR_DATA_KEY;
  if (previous) process.env.SUDOR_DATA_KEY_PREVIOUS = previous; else delete process.env.SUDOR_DATA_KEY_PREVIOUS;
};

const vault = await import('./dist/vault.js');
const store = await import('./dist/store.js');
const reload = () => { vault.resetForTest(); store.reloadForTest(); };
const files = () => readdirSync(DIR);

const PURPOSE = 'sudor:people:v1';
const SECRET = 'furosemide';

console.log('\nSealing round trips, and hides what it holds');
{
  setKey(keyA); vault.resetForTest();
  const sealed = vault.sealIfConfigured(JSON.stringify({ meds: [SECRET, 'metoprolol'] }), PURPOSE);
  check('the sealed text is an envelope', vault.looksSealed(sealed));
  check('it does not contain the plaintext', !sealed.includes(SECRET) && !sealed.includes('metoprolol'));
  const opened = vault.open(sealed, PURPOSE);
  check('it opens back to the original', JSON.parse(opened.plain).meds[0] === SECRET);
  check('and reports it was sealed', opened.wasSealed === true);
  check('and under which key', opened.keyId === vault.status().keyId, `${opened.keyId}`);
}

console.log('\nA nonce is never reused, which is the one catastrophic GCM mistake');
{
  setKey(keyA); vault.resetForTest();
  const seen = new Set();
  for (let i = 0; i < 400; i += 1) seen.add(JSON.parse(vault.sealIfConfigured('identical text', PURPOSE)).iv);
  check('400 seals of identical text used 400 different nonces', seen.size === 400, String(seen.size));
  const a = vault.sealIfConfigured('same', PURPOSE);
  const b = vault.sealIfConfigured('same', PURPOSE);
  check('so the ciphertext differs too', JSON.parse(a).ct !== JSON.parse(b).ct);
}

console.log('\nEncryption is off without a key, and says so');
{
  setKey(''); vault.resetForTest();
  check('encryptionOn is false', vault.encryptionOn() === false);
  check('text passes through unchanged', vault.sealIfConfigured('plain', PURPOSE) === 'plain');
  check('and status reports it', vault.status().encryptedAtRest === false);
  const o = vault.open('{"a":1}', PURPOSE);
  check('a plaintext file opens as plaintext', o.wasSealed === false && o.plain === '{"a":1}');
}

console.log('\nA badly formed key is refused at boot, not on the first write');
{
  setKey(Buffer.from('too short').toString('base64')); vault.resetForTest();
  let code = null;
  try { vault.assertRequirementMet(); } catch (e) { code = e.code; }
  check('a short key is a bad_key error', code === 'bad_key', String(code));
  setKey(keyA); vault.resetForTest();
  check('a good key passes', (() => { try { vault.assertRequirementMet(); return true; } catch { return false; } })());
}

console.log('\nRequire-encryption turns a missing key into a boot failure');
{
  setKey(''); vault.resetForTest();
  process.env.SUDOR_REQUIRE_ENCRYPTION = 'on';
  let code = null;
  try { vault.assertRequirementMet(); } catch (e) { code = e.code; }
  check('no key plus require is refused', code === 'no_key', String(code));
  setKey(keyA); vault.resetForTest();
  check('a key satisfies it', (() => { try { vault.assertRequirementMet(); return true; } catch { return false; } })());
  delete process.env.SUDOR_REQUIRE_ENCRYPTION;
}

console.log('\nA file is bound to its purpose, so it cannot be swapped for another');
{
  setKey(keyA); vault.resetForTest();
  const sealed = vault.sealIfConfigured('{"x":1}', 'sudor:people:v1');
  let code = null;
  try { vault.open(sealed, 'sudor:auth:v1'); } catch (e) { code = e.code; }
  check('opening under a different purpose fails authentication', code === 'auth_failed', String(code));
}

console.log('\nTampering is detected, and is not a key problem');
{
  setKey(keyA); vault.resetForTest();
  const env = JSON.parse(vault.sealIfConfigured('{"x":1}', PURPOSE));
  const flipped = Buffer.from(env.ct, 'base64'); flipped[0] ^= 0xff;
  let code = null;
  try { vault.open(JSON.stringify({ ...env, ct: flipped.toString('base64') }), PURPOSE); } catch (e) { code = e.code; }
  check('a flipped ciphertext bit fails authentication', code === 'auth_failed', String(code));

  const badTag = Buffer.from(env.tag, 'base64'); badTag[0] ^= 0x01;
  code = null;
  try { vault.open(JSON.stringify({ ...env, tag: badTag.toString('base64') }), PURPOSE); } catch (e) { code = e.code; }
  check('a flipped tag bit fails authentication', code === 'auth_failed', String(code));

  code = null;
  try { vault.open(JSON.stringify({ ...env, iv: Buffer.alloc(4).toString('base64') }), PURPOSE); } catch (e) { code = e.code; }
  check('a nonce of the wrong size is malformed', code === 'malformed', String(code));
}

console.log('\nA wrong or missing key is a configuration error, and never touches the file');
{
  setKey(keyA); reload();
  store.update('acct:one', (p) => { p.medications.push({ spoken: SECRET, generic: SECRET, drugClass: 'x', mechanisms: [] }); });
  const before = readFileSync(FILE, 'utf8');
  check('the file on disk is sealed', vault.looksSealed(before));
  check('and does not contain the medication', !before.includes(SECRET));

  setKey(keyB); reload();
  let code = null;
  try { store.get('acct:one'); } catch (e) { code = e.code; }
  check('the wrong key refuses to load', code === 'unknown_key', String(code));
  check('the file is byte for byte unchanged', readFileSync(FILE, 'utf8') === before);
  check('and nothing was quarantined', files().every((f) => !f.includes('corrupt')), files().join(','));

  // The dangerous follow up: after that refusal, an ordinary write must not run.
  let wrote = false;
  try { store.update('acct:two', () => {}); wrote = true; } catch { /* expected */ }
  check('a write after the refusal also refuses', wrote === false);
  check('so the file is still unchanged', readFileSync(FILE, 'utf8') === before);

  setKey(''); reload();
  code = null;
  try { store.get('acct:one'); } catch (e) { code = e.code; }
  check('no key at all also refuses', code === 'no_key', String(code));
  check('and still leaves the file alone', readFileSync(FILE, 'utf8') === before);

  setKey(keyA); reload();
  check('the right key gets everything back',
    store.get('acct:one').medications[0]?.spoken === SECRET);
}

console.log('\nA damaged file is set aside, not overwritten');
{
  rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true });
  setKey(keyA); reload();
  store.update('acct:keep', (p) => { p.medications.push({ spoken: SECRET, generic: SECRET, drugClass: 'x', mechanisms: [] }); });
  const good = JSON.parse(readFileSync(FILE, 'utf8'));
  const flipped = Buffer.from(good.ct, 'base64'); flipped[3] ^= 0xff;
  const damaged = JSON.stringify({ ...good, ct: flipped.toString('base64') });
  writeFileSync(FILE, damaged);

  reload();
  const people = store.allEntries();
  check('the process carries on, empty', people.length === 0, String(people.length));
  const aside = files().filter((f) => f.includes('corrupt'));
  check('the damaged file was set aside', aside.length === 1, files().join(','));
  check('with every byte preserved', readFileSync(`${DIR}/${aside[0]}`, 'utf8') === damaged);

  // The bug that used to delete everybody.
  store.update('acct:new', () => {});
  check('a later write does not resurrect or destroy the evidence',
    readFileSync(`${DIR}/${aside[0]}`, 'utf8') === damaged);
}

console.log('\nA corrupt plaintext file gets the same treatment');
{
  rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true });
  setKey(''); reload();
  writeFileSync(FILE, '{"acct:one": {"medications": [ "half a rec');
  reload();
  store.update('acct:two', () => {});
  const aside = files().filter((f) => f.includes('corrupt'));
  check('the unparseable file was kept', aside.length === 1, files().join(','));
  check('with its original bytes', readFileSync(`${DIR}/${aside[0]}`, 'utf8').startsWith('{"acct:one"'));
}

console.log('\nAdding a key migrates existing plaintext, immediately');
{
  rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true });
  setKey(''); reload();
  store.update('acct:legacy', (p) => { p.medications.push({ spoken: SECRET, generic: SECRET, drugClass: 'x', mechanisms: [] }); });
  check('it starts as plaintext', readFileSync(FILE, 'utf8').includes(SECRET));

  setKey(keyA); reload();
  store.get('acct:legacy'); // a read, not a write
  const after = readFileSync(FILE, 'utf8');
  check('a mere read sealed it', vault.looksSealed(after) && !after.includes(SECRET));
  check('and nothing was lost', store.get('acct:legacy').medications[0]?.spoken === SECRET);
}

console.log('\nRotation: the old key still opens, and the next load re-seals');
{
  rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true });
  setKey(keyA); reload();
  store.update('acct:r', (p) => { p.medications.push({ spoken: SECRET, generic: SECRET, drugClass: 'x', mechanisms: [] }); });
  const oldKid = JSON.parse(readFileSync(FILE, 'utf8')).kid;

  setKey(keyB, keyA); reload();
  check('the previous key is counted', vault.status().previousKeys === 1);
  check('the data still opens', store.get('acct:r').medications[0]?.spoken === SECRET);
  const newKid = JSON.parse(readFileSync(FILE, 'utf8')).kid;
  check('and was re-sealed under the new key', newKid !== oldKid && newKid === vault.status().keyId, `${oldKid} -> ${newKid}`);

  // With the old key dropped entirely, the file must still open.
  setKey(keyB); reload();
  check('the old key can now be retired', store.get('acct:r').medications[0]?.spoken === SECRET);
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
