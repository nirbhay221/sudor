// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * The demo must never be a way to send words to a stranger.
 *
 * A sandbox visitor can add any address as a contact and confirm it themselves,
 * because the confirmation is on the caller's side and not the recipient's. They can
 * then describe heat stroke and the server emails that address a message containing
 * their own text, from this operator's domain. SES sandbox mode, which only delivers
 * to verified recipients, is what has been standing in the way, and it is a setting
 * somebody changes the day they ask for production access.
 *
 * Tested with a fake transport that records what would have been sent, configured as
 * if email were fully set up, which is the situation the guard exists for.
 */
import { mkdirSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const DIR = './data/test-email-guard';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.SUDOR_DATA = `${DIR}/people.json`;
process.env.SUDOR_AUTH_DATA = `${DIR}/auth.json`;
delete process.env.SUDOR_DATA_KEY;

const notify = await import('./dist/notify.js');
const alerts = await import('./dist/alerts.js');
const store = await import('./dist/store.js');
const weather = await import('./dist/weather.js');

const sent = [];
notify.configureForTest({
  from: 'sudor@example.org',
  transport: async (mail) => { sent.push(mail); return { ok: true }; },
});

const contact = (name, email) => ({
  name, email, relation: 'daughter', notifyOn: ['emergency', 'hot_day'],
  confirmedAt: new Date().toISOString(), askedAt: new Date().toISOString(),
});
const victim = 'victim@example.com';
const words = 'click here to claim your prize at http://example.invalid';

const give = (id, email = victim) => {
  store.update(id, (p) => {
    p.lat = 33.45; p.lon = -112.07; p.locationName = 'Phoenix'; p.locationStatus = 'ready';
    p.contacts.push(contact('Somebody', email));
  });
};

console.log('\nThe predicate itself');
{
  check('a sandbox may not cause email', notify.canEmailFor('demo:' + 'a'.repeat(32)) === false);
  check('a linked account may', notify.canEmailFor('acct:jordan') === true);
  check('local development may', notify.canEmailFor('local-dev') === true);
  check('a name merely containing "demo" is not a sandbox', notify.canEmailFor('acct:demo:fake') === true);
  check('the refusal is a plain sentence', /public demo/.test(notify.DEMO_NO_EMAIL) && !/Error|at /.test(notify.DEMO_NO_EMAIL));
}

console.log('\nAn emergency from a sandbox emails nobody, with attacker text in it');
{
  sent.length = 0;
  const id = 'demo:' + 'b'.repeat(32);
  give(id);
  const r = alerts.alertEmergency(id, words);
  await new Promise((res) => setTimeout(res, 50));
  check('nothing was sent', sent.length === 0, JSON.stringify(sent.map((m) => m.to)));
  check('the victim address never reached the transport', !sent.some((m) => m.to === victim));
  check('the result says it was the demo, so the tool can say so', r.demo === true, JSON.stringify(r));
  check('and that nothing was configured to go', r.configured === false);
}

console.log('\nThe same emergency from a linked account still emails, so this is the guard and not a broken path');
{
  sent.length = 0;
  const id = 'acct:jordan';
  give(id);
  const r = alerts.alertEmergency(id, 'my dad is confused and his skin is hot and dry');
  await new Promise((res) => setTimeout(res, 50));
  check('the email was sent', sent.length === 1, String(sent.length));
  check('to the confirmed contact', sent[0]?.to === victim);
  check('with the description in it', sent[0]?.text.includes('confused'));
  check('and the result is not marked demo', r.demo === undefined);
}

console.log('\nThe hot-day sweep skips sandboxes entirely');
{
  sent.length = 0;
  store.reloadForTest();
  rmSync(`${DIR}/people.json`, { force: true });
  // Different addresses, so a send can be attributed to exactly one of them.
  give('demo:' + 'c'.repeat(32), 'sandbox-victim@example.com');
  give('acct:casey', 'family@example.com');
  const hours = Array.from({ length: 48 }, (_, i) => ({
    local: new Date(Date.now() + i * 3.6e6).toISOString().slice(0, 16),
    time: new Date(Date.now() + i * 3.6e6).toISOString(),
    tempF: 112, humidityPct: 20, uvIndex: 10, windMph: 3, isDay: true, aqi: 50, solarWm2: 900, wetBulbF: 80,
  }));
  weather.seedForTest({
    lat: 33.45, lon: -112.07, fetchedAt: new Date().toISOString(), timezone: 'America/Phoenix', utcOffsetSeconds: -25200,
    tempF: 112, humidityPct: 20, uvIndex: 10, windMph: 3, isDay: true, aqi: 50, solarWm2: 900, wetBulbF: 80, stale: false, hourly: hours,
  });
  // 5 pm in Phoenix is midnight UTC, so the evening check is due.
  const evening = new Date(); evening.setUTCHours(0, 0, 0, 0);
  const attempted = await alerts.checkHotDayAlerts(evening);
  await new Promise((res) => setTimeout(res, 100));

  const toFamily = sent.filter((m) => m.to === 'family@example.com').length;
  const toSandbox = sent.filter((m) => m.to === 'sandbox-victim@example.com').length;
  // The positive control. Without it, "the sandbox got nothing" could just mean the
  // sweep never ran at all, and the test would pass for the wrong reason.
  check('the linked account contact WAS emailed, so the sweep really ran', toFamily === 1, `family=${toFamily} attempted=${attempted.length}`);
  check('the sandbox contact was not', toSandbox === 0, `sandbox=${toSandbox}`);
  check('and nothing was even attempted for the sandbox address', !attempted.some((d) => d.to === 'sandbox-victim@example.com'));
}

console.log('\nEvery call site of sendEmail is behind the guard');
{
  const { readFileSync, readdirSync } = await import('node:fs');
  const files = ['./src/alerts.ts', ...readdirSync('./src/tools').map((f) => `./src/tools/${f}`)];
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (!/sendEmail\(/.test(src)) continue;
    if (!/canEmailFor/.test(src)) offenders.push(f);
  }
  check('no file calls sendEmail without referring to canEmailFor', offenders.length === 0, offenders.join(', '));
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
