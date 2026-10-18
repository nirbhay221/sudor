/**
 * The DynamoDB store and the scheduled alert check, against an in-memory table with
 * DynamoDB's own version rule. No network and no AWS account.
 *
 * What it has to show: a change made in one place is not lost when another place
 * wrote the same person first; a record sealed for one person cannot be opened as
 * another; a forgotten person is gone from the table; a sandbox record carries its
 * own deletion date; and the scheduled check, starting from nothing but the table,
 * emails the family once and writes down that it did before it sends.
 */
import { randomBytes } from 'node:crypto';

process.env.SUDOR_STORE = 'dynamodb';
process.env.SUDOR_DATA = './data/test-table/people.json';
process.env.SUDOR_OUTBOX = './data/test-table/outbox.jsonl';
process.env.SUDOR_IMPACT = './data/test-table/impact.json';
process.env.SUDOR_DATA_KEY = randomBytes(32).toString('base64');
process.env.SUDOR_RECIPIENT_CONSENT = 'off';

const table = await import('./dist/table.js');
const store = await import('./dist/store.js');
const notify = await import('./dist/notify.js');
const weather = await import('./dist/weather.js');
const warnings = await import('./dist/warnings.js');
const { sweep } = await import('./dist/sweep.js');

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const mem = table.memoryTable();
table.configureForTest(mem);
await store.init();

console.log('\nOne item per person, sealed');
{
  store.update('acct:ana', (p) => { p.conditions = ['heart_disease']; });
  await store.flush();
  const row = mem.rows.get('acct:ana');
  check('a write lands as one item, version 1', row?.v === 1, JSON.stringify(row?.v));
  check('...sealed: no health detail is readable on the table', row && !/heart_disease/.test(row.body), row?.body?.slice(0, 60));
  check('...and a person record carries no deletion date', row?.ttl === null);
  // The same sealed body moved onto another id must not open.
  mem.rows.set('acct:eve', { ...row, id: 'acct:eve' });
  store.reloadForTest();
  await store.init();
  check('a sealed record copied onto another person does not open, and is skipped', store.get('acct:eve').conditions.length === 0 && store.get('acct:ana').conditions[0] === 'heart_disease');
  mem.rows.delete('acct:eve');
}

console.log('\nA conflict keeps both changes');
{
  // Process A and process B both read version N of Bo.
  store.update('acct:bo', (p) => { p.conditions = ['asthma']; });
  await store.flush();
  const n = mem.rows.get('acct:bo').v;
  // B writes N+1 straight to the table: it adds a sent alert.
  const vault = await import('./dist/vault.js');
  const bBody = JSON.parse(vault.open(mem.rows.get('acct:bo').body, 'sudor:people:v1:acct:bo').plain);
  bBody.alertsSent = ['alone:2026-10-17'];
  mem.rows.set('acct:bo', { id: 'acct:bo', body: vault.sealIfConfigured(JSON.stringify(bBody), 'sudor:people:v1:acct:bo'), v: n + 1, ttl: null });
  // A, still at N, adds an outing.
  store.update('acct:bo', (p) => { p.outings = [...p.outings, { at: 'y', felt: 'unwell', heatIndexF: 101, minutes: 30, note: null }]; });
  await store.flush();
  const final = JSON.parse(vault.open(mem.rows.get('acct:bo').body, 'sudor:people:v1:acct:bo').plain);
  check('a write that finds a newer version is refused, and made again on top of it', mem.rows.get('acct:bo').v === n + 2);
  check('...so their alert and our outing are both there', final.alertsSent.includes('alone:2026-10-17') && final.outings.length === 1 && final.conditions[0] === 'asthma', JSON.stringify({ a: final.alertsSent, o: final.outings.length }));
  check('...and memory holds the merged record too', store.get('acct:bo').alertsSent.includes('alone:2026-10-17'));

  // refresh() picks up a write made elsewhere when nothing of ours is waiting.
  bBody.alertsSent = ['alone:2026-10-17', 'hot_home:2026-10-17'];
  bBody.outings = final.outings;
  mem.rows.set('acct:bo', { id: 'acct:bo', body: vault.sealIfConfigured(JSON.stringify(bBody), 'sudor:people:v1:acct:bo'), v: n + 3, ttl: null });
  await store.refresh('acct:bo');
  check('refresh() reads a newer version written elsewhere', store.get('acct:bo').alertsSent.includes('hot_home:2026-10-17'));
}

console.log('\nForgetting, and the sandbox');
{
  store.forget('acct:bo');
  await store.flush();
  check('a forgotten person is deleted from the table, not blanked', !mem.rows.has('acct:bo'));
  store.update('demo:0123456789abcdef0123456789abcdef', (p) => { p.conditions = ['asthma']; });
  await store.flush();
  const ttl = mem.rows.get('demo:0123456789abcdef0123456789abcdef')?.ttl;
  const days = (ttl * 1000 - Date.now()) / 86_400_000;
  check('a sandbox record carries its own deletion date, seven days on, for DynamoDB to enforce', days > 6.9 && days <= 7.01, String(days));
  // Removed elsewhere (by that TTL, say): refresh() drops it from memory.
  mem.rows.delete('demo:0123456789abcdef0123456789abcdef');
  await store.refresh('demo:0123456789abcdef0123456789abcdef');
  check('...and once DynamoDB has deleted it, refresh() forgets it too', store.get('demo:0123456789abcdef0123456789abcdef').conditions.length === 0);
}

console.log('\nA write that fails is kept and tried again');
{
  let down = true;
  const flaky = { ...mem, async put(...a) { if (down) throw new Error('throttled'); return mem.put(...a); } };
  table.configureForTest(flaky);
  store.update('acct:cy', (p) => { p.conditions = ['copd']; });
  let threw = false;
  try { await store.flush(); } catch { threw = true; }
  check('flush() says so when DynamoDB refused', threw && !mem.rows.has('acct:cy'));
  down = false;
  await store.flush();
  check('...and the change is written on the next try, not lost', mem.rows.has('acct:cy'));
  table.configureForTest(mem);
}

console.log('\nThe scheduled check, from the table alone');
{
  const lat = 33.45, lon = -112.07;
  // A record written by the server: lives alone, not heard from for two days, one confirmed contact.
  store.update('acct:dee', (p) => {
    p.lat = lat; p.lon = lon; p.locationName = 'Phoenix'; p.country = 'US'; p.locationStatus = 'ready';
    p.medications = [{ spoken: 'metoprolol', generic: 'metoprolol', drugClass: 'beta blocker', mechanisms: ['electrolyte_imbalance', 'reduced_sweating'] }];
    p.conditions = ['heart_disease'];
    p.livesAlone = true;
    p.lastSeenAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    p.contacts = [{ id: 'c1', name: 'Sam', email: 'sam@example.org', relation: 'son', notifyOn: ['emergency', 'hot_day'], addedAt: 'x', confirmedAt: 'x' }];
  });
  await store.flush();
  store.reloadForTest();

  // 3 pm where they are, 108 all afternoon. The network is off, so the forecast is this one.
  const nowMs = Date.now();
  const off = ((15 - new Date(nowMs).getUTCHours() + 24) % 24) * 3600;
  const hour = (i) => { const t = nowMs + (i - 1) * 3_600_000; return { time: new Date(t).toISOString(), local: new Date(t + off * 1000).toISOString().slice(0, 13) + ':00', tempF: 108, humidityPct: 20, uvIndex: 9, windMph: 4, isDay: true, aqi: 40, solarWm2: 800, wetBulbF: 70 }; };
  weather.seedForTest({ lat, lon, fetchedAt: new Date().toISOString(), timezone: 'America/Phoenix', utcOffsetSeconds: off, tempF: 108, humidityPct: 20, uvIndex: 9, windMph: 4, isDay: true, aqi: 40, solarWm2: 800, wetBulbF: 70, hourly: Array.from({ length: 12 }, (_, i) => hour(i)), stale: false });
  warnings.configureForTest(async () => []);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline in this test'); };

  const sent = [];
  const order = [];
  notify.configureForTest({ from: 'sudor@example.org', transport: async (email) => { order.push(['send', JSON.stringify([...mem.rows.keys()])]); order.push(['marked', /alone:/.test(store.get('acct:dee').alertsSent.join())]); sent.push(email); } });
  const r = await sweep(new Date(nowMs));
  check('the check reads people from the table with nothing in memory first', r.people === 1 && r.places === 1, JSON.stringify(r));
  check('...emails the contact of somebody alone and unheard from on a dangerous day', r.sent.alone === 1 && sent.some((m) => m.subject === 'Please check on them today'), JSON.stringify(r.sent));
  check('...with nothing about their health in it', sent.every((m) => !/metoprolol|heart/i.test(m.text)));
  const vault = await import('./dist/vault.js');
  const onTable = JSON.parse(vault.open(mem.rows.get('acct:dee').body, 'sudor:people:v1:acct:dee').plain);
  check('...and wrote down that it had, on the table', onTable.alertsSent.some((k) => k.startsWith('alone:')));
  check('...before it sent', order.find(([k]) => k === 'marked')?.[1] === true);
  const again = await sweep(new Date(nowMs));
  check('the next run, ten minutes later, sends nothing more', again.sent.alone === 0 && sent.filter((m) => m.subject === 'Please check on them today').length === 1);

  // EventBridge Scheduler delivers at least once: a second run can start before the first has written.
  // Here this run has read Eli, and the other run then marks and sends. This one must not send again.
  store.update('acct:eli', (p) => {
    p.lat = lat; p.lon = lon; p.locationName = 'Phoenix'; p.country = 'US'; p.locationStatus = 'ready';
    p.conditions = ['heart_disease']; p.livesAlone = true;
    p.lastSeenAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    p.contacts = [{ id: 'c2', name: 'Ria', email: 'ria@example.org', relation: 'daughter', notifyOn: ['emergency', 'hot_day'], addedAt: 'x', confirmedAt: 'x' }];
  });
  await store.flush();
  await store.init();
  const row = mem.rows.get('acct:eli');
  const theirs = JSON.parse(vault.open(row.body, 'sudor:people:v1:acct:eli').plain);
  const day = new Date(nowMs + off * 1000).toISOString().slice(0, 10);
  theirs.alertsSent = [...theirs.alertsSent, `alone:${day}`];
  mem.rows.set('acct:eli', { ...row, body: vault.sealIfConfigured(JSON.stringify(theirs), 'sudor:people:v1:acct:eli'), v: row.v + 1 });
  const before = sent.filter((m) => m.to === 'ria@example.org').length;
  await (await import('./dist/alerts.js')).checkOnAlone(new Date(nowMs));
  check('a second run that read before the first one wrote sends nothing', sent.filter((m) => m.to === 'ria@example.org').length === before, String(sent.filter((m) => m.to === 'ria@example.org').length));
  const after = JSON.parse(vault.open(mem.rows.get('acct:eli').body, 'sudor:people:v1:acct:eli').plain);
  check('...and the mark is on the table once', after.alertsSent.filter((k) => k === `alone:${day}`).length === 1, JSON.stringify(after.alertsSent));

  // A sandbox record is never read for.
  store.update('demo:fedcba9876543210fedcba9876543210', (p) => { p.lat = lat; p.lon = lon; p.livesAlone = true; p.contacts = [{ name: 'X', email: 'x@example.org', relation: null, notifyOn: ['hot_day'], addedAt: 'x', confirmedAt: 'x' }]; });
  await store.flush();
  check('a sandbox record costs the scheduled check nothing', (await sweep(new Date(nowMs))).people === 2); // Dee and Eli
  globalThis.fetch = realFetch;
  warnings.configureForTest(null);
}

console.log('\nMoving a server from the file to the table');
{
  const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
  mkdirSync('./data/test-table', { recursive: true });
  const people = { 'acct:file-one': { conditions: ['asthma'] }, 'demo:00112233445566778899aabbccddeeff': { conditions: [], touchedAt: new Date().toISOString() } };
  writeFileSync(process.env.SUDOR_DATA, JSON.stringify(people));
  const fresh = table.memoryTable();
  table.configureForTest(fresh);
  const first = await store.copyFileToTable();
  check('every record in the file is copied in', first.copied === 2 && first.already === 0, JSON.stringify(first));
  const vault = await import('./dist/vault.js');
  check('...each sealed for its own id', JSON.parse(vault.open(fresh.rows.get('acct:file-one').body, 'sudor:people:v1:acct:file-one').plain).conditions[0] === 'asthma');
  check('...the sandbox one with its deletion date', fresh.rows.get('demo:00112233445566778899aabbccddeeff').ttl > Date.now() / 1000);
  const second = await store.copyFileToTable();
  check('running it again changes nothing', second.copied === 0 && second.already === 2);
  check('the file is kept, so going back is possible', readFileSync(process.env.SUDOR_DATA, 'utf8').length > 0);
  check('...and the store in memory was not touched by the copy', store.get('acct:file-one').conditions.length === 0);
  table.configureForTest(mem);
}

{
  // The Lambda's files are gone when it stops, so what it counts goes on the table, and /impact adds it in.
  const impact = await import('./dist/impact.js');
  impact.resetForTest();
  impact.count('familyTold', 'acct:server-side');
  impact.countOnTable(true);
  impact.count('familyTold', 'acct:from-lambda');
  impact.count('familyTold', 'demo:' + 'b'.repeat(32));
  await impact.flush();
  impact.countOnTable(false);
  const today = new Date().toISOString().slice(0, 10);
  check('a count made in the Lambda lands on the table, per side and day', mem.counts.get(`impact:real:${today}`)?.familyTold === 1 && mem.counts.get(`impact:demo:${today}`)?.familyTold === 1);
  check("...and not in the Lambda's own file", impact.summary(30).real.familyTold === 1);
  const both = await impact.summaryWithTable(30);
  check("/impact adds the table's counts to the server's own", both.real.familyTold === 2 && both.demo.familyTold === 1, JSON.stringify(both.real));
  check('...and a person scan never returns a counter', !(await mem.scan()).some((i) => i.id.startsWith('impact:')));
  // /impact is public. Asked in a loop, it must not be a table read every time.
  let reads = 0;
  table.configureForTest({ ...mem, async counters(ids) { reads++; return mem.counters(ids); } });
  for (let i = 0; i < 5; i++) await impact.summaryWithTable(400);
  check('asking /impact again and again reads the table once', reads === 1, String(reads));
  table.configureForTest(mem);
}

{
  // DynamoDB deletes a sandbox at its ttl even while this server still has it in memory and in use.
  const id = 'demo:' + 'c'.repeat(32);
  store.update(id, (p) => { p.conditions = ['asthma']; });
  await store.flush();
  mem.rows.delete(id);
  store.update(id, (p) => { p.medications = [...p.medications, { name: 'lasix', generic: 'furosemide' }]; });
  await store.flush();
  const vault = await import('./dist/vault.js');
  const back = mem.rows.get(id) && JSON.parse(vault.open(mem.rows.get(id).body, `sudor:people:v1:${id}`).plain);
  check('a sandbox DynamoDB expired under a later write is written back whole', back?.conditions?.[0] === 'asthma' && back?.medications?.length === 1, JSON.stringify(back));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
