/**
 * Sudor talking to another MCP server, and the two rules that make it safe.
 *
 * A stand-in Orbita is started here, speaking real Streamable HTTP MCP, and
 * every request it receives is kept so the test can read what actually went
 * over the wire. That is the only way to check the rule that matters: no part
 * of a person's profile ever leaves this process.
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

/** Every request body the stand-in received, so the test can read the wire. */
const heard = [];
let scales = { g: 4, days: [{ date: '2026-09-19', g: 4 }] };

const orbita = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    heard.push(body);
    const reply = (result) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    };
    if (body.method === 'initialize') {
      return reply({
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'stand-in orbita', version: '0.1.0' },
      });
    }
    if (body.method === 'tools/call') {
      return reply({
        content: [{ type: 'text', text: 'Kp is 7.7 right now.' }],
        structuredContent: { kpNow: 7.7, scales, peak: { kp: 8.3, time: new Date().toISOString() } },
      });
    }
    res.writeHead(202).end();
  });
});
await new Promise((r) => orbita.listen(8787, '127.0.0.1', r));
const stop = () => { try { orbita.close(); } catch { /* already gone */ } };
process.on('exit', stop);

process.env.SUDOR_ORBITA_URL = 'http://127.0.0.1:8787';
const spaceweather = await import('./dist/spaceweather.js');

console.log('\nOne MCP server asking another');
await spaceweather.start();
const seen = spaceweather.lastSeen();
check('it reads the storm level out of the other server', seen?.g === 4, JSON.stringify(seen));
check('...and the peak Kp with it', seen?.peakKp === 8.3, JSON.stringify(seen));
check('...and reports it, because a G4 is worth saying', spaceweather.outlook()?.g === 4);

console.log('\nWhat crosses the wire');
const calls = heard.filter((h) => h.method === 'tools/call');
check('exactly one tool call was made', calls.length === 1, JSON.stringify(heard.map((h) => h.method)));
check('...and it asked for the public storm status', calls[0]?.params?.name === 'storm_status', JSON.stringify(calls[0]?.params));
check('...with no arguments at all', JSON.stringify(calls[0]?.params?.arguments ?? {}) === '{}', JSON.stringify(calls[0]?.params?.arguments));
const transcript = JSON.stringify(heard).toLowerCase();
for (const secret of ['lisinopril', 'medication', 'condition', 'lat', 'lon', 'phoenix', 'outing', 'contact', 'email'])
  check(`...and nothing in the transcript mentions "${secret}"`, !transcript.includes(secret));

console.log('\nHow it is said');
const said = spaceweather.speak(spaceweather.outlook());
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
scales = { g: 1, days: [{ date: '2026-09-19', g: 1 }] };
spaceweather.configureForTest(null);
await spaceweather.start();
check('a G1 is held but not spoken', spaceweather.lastSeen()?.g === 1 && spaceweather.outlook() === null);

console.log('\nAnd a failure says nothing, rather than saying it is fine');
spaceweather.configureForTest(async () => null);
await spaceweather.start();
check('an unreachable server leaves no outlook at all', spaceweather.outlook() === null);
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
