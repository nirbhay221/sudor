// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * Sudor reading NOAA's space weather feed, and the two rules that make it safe.
 *
 * A stand-in NOAA is started here, serving the same two files in the same
 * shape, and every request it receives is kept so the test can read what
 * actually went over the wire. That is the only way to check the rule that
 * matters: no part of a person's profile ever leaves this process.
 *
 * The other rule is that a failure is silence. A server that cannot reach the
 * space weather feed must say nothing about it, never that the sky looks clear.
 */
import { createServer } from 'node:http';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

/** Every request the stand-in received, so the test can read the wire. */
const heard = [];
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const row = (n, g) => ({ DateStamp: day(n), TimeStamp: '00:00:00', R: { Scale: null }, S: { Scale: null }, G: { Scale: g == null ? null : String(g), Text: null } });
// Cut down from the real noaa-scales.json: "0" today, "-1" yesterday, "1" to "3" the outlook.
let scales = { '-1': row(-1, 0), 0: row(0, 2), 1: row(1, 4), 2: row(2, 3), 3: row(3, null) };
// The Kp file carries the past week too: a block long over, at 9, must not be called the peak.
const block = (h, kp) => ({ time_tag: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 + h * 3_600_000).toISOString().slice(0, 19), kp, observed: h < 0 ? 'observed' : 'predicted', noaa_scale: null });
const kp = [block(-48, 9), block(-3, 4), block(3, 8.33), block(6, 6)];
let kpStatus = 200;

const noaa = createServer((req, res) => {
  heard.push({ method: req.method, url: req.url, headers: req.headers });
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/products/noaa-scales.json') return send(200, scales);
  if (req.url === '/products/noaa-planetary-k-index-forecast.json') return send(kpStatus, kpStatus === 200 ? kp : {});
  send(404, {});
});
await new Promise((r) => noaa.listen(8787, '127.0.0.1', r));
const stop = () => { try { noaa.close(); } catch { /* already gone */ } };
process.on('exit', stop);

process.env.SUDOR_SWPC_BASE = 'http://127.0.0.1:8787/products';
const spaceweather = await import('./dist/spaceweather.js');

console.log('\nReading NOAA');
await spaceweather.start();
const seen = spaceweather.lastSeen();
check('it reads the worst storm level in the outlook', seen?.g === 4, JSON.stringify(seen));
check('...on the day it is forecast', seen?.when === day(1), JSON.stringify(seen));
check('...and the peak Kp still to come, not one from last week', seen?.peakKp === 8.33, JSON.stringify(seen));
check('...and reports it, because a G4 is worth saying', spaceweather.outlook()?.g === 4);

console.log('\nWhat crosses the wire');
check('exactly the two NOAA files were asked for', heard.length === 2 && heard.every((h) => h.method === 'GET'), JSON.stringify(heard.map((h) => h.url)));
check('...with no query at all', heard.every((h) => !h.url.includes('?')), JSON.stringify(heard.map((h) => h.url)));
const transcript = JSON.stringify(heard).toLowerCase();
for (const secret of ['lisinopril', 'medication', 'condition', 'lat=', 'lon=', 'phoenix', 'outing', 'contact', 'email', 'orbita'])
  check(`...and nothing in the transcript mentions "${secret}"`, !transcript.includes(secret));

console.log('\nWhen only part of the feed answers');
heard.length = 0;
kpStatus = 503;
spaceweather.configureForTest(null);
await spaceweather.start();
check('the storm level still comes through without the Kp file', spaceweather.lastSeen()?.g === 4 && spaceweather.lastSeen()?.peakKp === null, JSON.stringify(spaceweather.lastSeen()));
kpStatus = 200;
scales = { '-1': row(-1, 0), 0: row(0, 5), 1: row(1, 4), 2: row(2, 3), 3: row(3, null) };
spaceweather.configureForTest(null);
await spaceweather.start();
check('a G5 today beats a G4 tomorrow, and is said as today', spaceweather.lastSeen()?.g === 5 && spaceweather.lastSeen()?.when === 'today', JSON.stringify(spaceweather.lastSeen()));
scales = 'not json at all';
spaceweather.configureForTest(null);
await spaceweather.start();
check('an answer in a shape it does not know is nothing, not a G0', spaceweather.lastSeen() === null, JSON.stringify(spaceweather.lastSeen()));

console.log('\nHow it is said');
const said = spaceweather.speak({ g: 4, when: "today", peakKp: 8.33, fetchedAt: Date.now() });
check('the level is named', /G4/.test(said), said);
/*
 * The wording started out quoting the worst line of the NOAA scale at people
 * who depend on mains power. The record does not support that: two blackouts
 * from geomagnetic storms in thirty-seven years, both G5, both outside the
 * United States, and the May 2024 G5 passed over North America with the lights
 * on. So the rule is that every mention carries the base rate.
 */
check('...and it says what has actually happened before, not the worst case', /May 2024/.test(said), said);
check('...and an outage is never predicted',
  /not a warning that you will lose power/.test(said) && !/expect an outage|prepare for an outage|likely to lose/i.test(said), said);
check('...and it ends on something the person can do at no cost', /charging it costs you nothing/.test(said), said);
const atFive = spaceweather.speak({ g: 5, when: 'today', peakKp: 9, fetchedAt: Date.now() });
check('a G5 names the one case there is, rather than implying there are many',
  /Quebec in 1989/.test(atFive) && /May 2024, passed with the lights on/.test(atFive), atFive);

console.log('\nA quiet sky says nothing');
scales = { '-1': row(-1, 0), 0: row(0, 1), 1: row(1, 1), 2: row(2, 0), 3: row(3, 0) };
spaceweather.configureForTest(null);
await spaceweather.start();
check('a G1 is held but not spoken', spaceweather.lastSeen()?.g === 1 && spaceweather.outlook() === null);

console.log('\nAnd a failure says nothing, rather than saying it is fine');
spaceweather.configureForTest(async () => null);
await spaceweather.start();
check('an unreachable feed leaves no outlook at all', spaceweather.outlook() === null);
spaceweather.seedForTest({ g: 5, when: 'today', peakKp: 9, fetchedAt: Date.now() - 4 * 60 * 60 * 1000 });
check('a reading four hours old is not offered as current', spaceweather.outlook() === null);
spaceweather.seedForTest({ g: 5, when: 'today', peakKp: 9, fetchedAt: Date.now() });
check('...while a fresh one is', spaceweather.outlook()?.g === 5);

console.log('\nWhat the customer actually hears');
process.env.SUDOR_DATA = './data/test-spaceweather.json';
const store = await import('./dist/store.js');
const { registerTools } = await import('./dist/tools.js');
const tools = {};
registerTools({ registerTool: (name, _cfg, handler) => { tools[name] = handler; } }, () => 'sw-test');
const text = (r) => r.content[0].text;
await tools.health_condition({ action: 'add', condition: 'diabetes' });

spaceweather.seedForTest({ g: 4, when: 'today', peakKp: 8.3, fetchedAt: Date.now() });
const prep = text(await tools.storm_prep({}));
check('storm prep mentions the storm', /G4 geomagnetic storm/.test(prep), prep.slice(0, 120));
check('...and still gives the insulin answer', /36 and 46 degrees/.test(prep));
// The rarest risk does not go in front of the one that matters most.
check('...with the insulin first and the storm as a footnote',
  prep.indexOf('36 and 46 degrees') < prep.indexOf('G4 geomagnetic storm'), prep.slice(0, 160));
check('...and says where the claim comes from',
  (await tools.storm_prep({})).structuredContent?.sources?.includes('https://www.swpc.noaa.gov/noaa-scales-explanation'));

spaceweather.seedForTest(null);
const quiet = text(await tools.storm_prep({}));
check('with nothing forecast it says nothing about space weather', !/geomagnetic|NOAA/.test(quiet), quiet.slice(0, 120));
check('...and the rest of the answer is unchanged', /36 and 46 degrees/.test(quiet));

stop();
const { rmSync } = await import('node:fs');
rmSync('./data/test-spaceweather.json', { force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
