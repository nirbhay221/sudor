/**
 * The demo page, tested against a real server.
 *
 * A page that quietly stops working is worse than no page, and the way it
 * breaks is always the same: a button points at a tool that was renamed, or at
 * an argument the schema no longer accepts. So this starts the built server,
 * fetches the page and its assets, then calls every single request the page
 * offers and fails if any of them comes back an error.
 *
 * It also checks the two things that would matter most here: that two visitors
 * never share one health profile, and that the page says plainly it is not
 * medical advice.
 */
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 8798;
const BASE = `http://localhost:${PORT}`;
const DATA = './data/test-web.json';
rmSync(DATA, { force: true });

const server = spawn(process.execPath, ['dist/server.js'], {
  env: { ...process.env, PORT: String(PORT), SUDOR_DATA: DATA, SUDOR_AUTH: 'off' },
  stdio: 'ignore',
});
const stop = () => { try { server.kill(); } catch { /* already gone */ } };
process.on('exit', stop);

let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(`${BASE}/health`)).ok; } catch { await wait(500); }
}
if (!up) { console.log('  FAIL  the server never came up'); stop(); process.exit(1); }

let rpcId = 0;
async function call(name, args = {}, sessionId = '42816a48288988c1b90e06066deea01d') {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-sudor-demo': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  const json = JSON.parse(line ? line.slice(6) : raw);
  return { error: json.error ?? null, text: json.result?.content?.[0]?.text ?? '', structured: json.result?.structuredContent ?? null };
}

console.log('\nThe page and everything it asks for');
for (const [path, type] of [['/', 'text/html'], ['/styles.css', 'text/css'], ['/app.js', 'javascript'], ['/requests.json', 'json'], ['/ui/window.html', 'text/html']]) {
  const res = await fetch(BASE + path);
  check(`${path} is served`, res.ok && (res.headers.get('content-type') ?? '').includes(type),
    `${res.status} ${res.headers.get('content-type')}`);
}

const html = readFileSync('./web/index.html', 'utf8');
const js = readFileSync('./web/app.js', 'utf8');
const css = readFileSync('./web/styles.css', 'utf8');
console.log('\nHouse style, and saying what this is');
for (const [name, text] of [['index.html', html], ['app.js', js], ['styles.css', css]]) {
  check(`no em dashes or arrows in ${name}`, !/[—–→←⇒]|&mdash;|&ndash;/.test(text));
}
check('the page sets a viewport, so it works on a phone', /name="viewport"/.test(html));
check('the panel is sandboxed', /id="panel"[^>]*sandbox="allow-scripts"/.test(html));
check('the page says it is not medical advice', /not medical advice/i.test(html));
check('the page says to call 911 in an emergency', /911/.test(html));
check('the page says plainly that Alexa is not in the loop', /Alexa is not in the loop/.test(html));

console.log('\nEvery tool the page names exists on the server');
const listed = await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/list' }),
}).then(async (r) => {
  const raw = await r.text();
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : raw).result.tools.map((t) => t.name);
});
const catalogue = JSON.parse(readFileSync('./web/requests.json', 'utf8'));
const named = [...new Set([...catalogue.tools, ...catalogue.groups.flatMap((g) => g.requests.map((r) => r.tool))])];
const missing = named.filter((t) => !listed.includes(t));
check(`all ${named.length} tools named on the page are registered`, missing.length === 0, missing.join(', '));
check('the dropdown lists every tool the server has', listed.every((t) => catalogue.tools.includes(t)),
  listed.filter((t) => !catalogue.tools.includes(t)).join(', '));

console.log('\nThe profile the page sets up for a visitor');
const fresh = await call('my_profile', {}, 'freshaaa0002');
check('a fresh visitor has no location', !fresh.structured?.location, JSON.stringify(fresh.structured));
check('the seed place is accepted', !(await call('register_location', catalogue.seed.location)).error);
for (const name of catalogue.seed.medications) {
  check(`the seed medication "${name}" is accepted`, !(await call('medication', { action: 'add', name })).error);
}
for (const condition of catalogue.seed.conditions) {
  check(`the seed condition "${condition}" is accepted`, !(await call('health_condition', { action: 'add', condition })).error);
}
// The place is geocoded in the background and the weather fetched after it, so
// give that the time a real visitor's browser would give it.
await wait(6000);
const profile = await call('my_profile');
check('the profile reads back with the place resolved', !!profile.structured?.location, JSON.stringify(profile.structured));

console.log('\nEvery request on the page, actually called');
for (const group of catalogue.groups) {
  for (const req of group.requests) {
    const out = await call(req.tool, req.args);
    check(`"${req.say}" answers`, !out.error && out.text.trim().length > 0, out.error?.message ?? '(empty answer)');
  }
}

console.log('\nThe emergency path, as the page exercises it');
const stroke = await call('warning_signs', { symptoms: 'confused, slurring words, hot dry skin, not sweating' });
check('heat stroke signs put 911 first', /call 911/i.test(stroke.text.slice(0, 120)), stroke.text.slice(0, 120));

console.log('\nTwo visitors are two profiles');
await call('register_location', { place: 'Miami, Florida' }, 'otheraaa0003');
await call('medication', { action: 'add', name: 'lithium' }, 'otheraaa0003');
const mine = await call('my_profile', {}, '42816a48288988c1b90e06066deea01d');
const theirs = await call('my_profile', {}, 'otheraaa0003');
check('one visitor never sees the other visitor\'s medications',
  !theirs.structured.medications.includes('doxycycline') && !mine.structured.medications.includes('lithium'),
  `${JSON.stringify(mine.structured.medications)} // ${JSON.stringify(theirs.structured.medications)}`);
const junk = await call('my_profile', {}, 'not a valid id!!');
check('a nonsense session id falls back instead of crashing', !junk.error, junk.error?.message);

console.log('\nA host opening a stream gets an answer, not a hung connection');
const streamStarted = Date.now();
const stream = await fetch(`${BASE}/mcp`, { headers: { accept: 'text/event-stream' } });
const streamMs = Date.now() - streamStarted;
check('GET /mcp answers 405 rather than hanging', stream.status === 405 && streamMs < 3000, `${stream.status} in ${streamMs} ms`);
check('...and says which method to use', (stream.headers.get('allow') ?? '').includes('POST'), stream.headers.get('allow') ?? '(none)');

console.log('\nClients that do not send the header the spec asks for');
const wildcard = await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: '*/*' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'tools/list' }),
});
const wildcardBody = await wildcard.text();
check('a plain curl, which sends Accept: */*, gets the tool list rather than a 406',
  wildcard.status === 200 && wildcardBody.includes('"tools"'), `${wildcard.status} ${wildcardBody.slice(0, 90)}`);
const jsonOnly = await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 901, method: 'tools/list' }),
});
check('...while a client that says it cannot read an event stream is still told so',
  jsonOnly.status === 406, String(jsonOnly.status));

console.log('\nHosts still speaking an older version of the protocol');
for (const version of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 902,
      method: 'initialize',
      params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'era-test', version: '0' } },
    }),
  });
  const raw = await res.text();
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  const body = JSON.parse(line ? line.slice(6) : raw);
  check(`a host on ${version} is answered on ${version}`,
    res.status === 200 && body.result?.protocolVersion === version, `${res.status} ${JSON.stringify(body).slice(0, 100)}`);
}
const stale = await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-session-id': 'a-session-this-server-never-issued',
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 903, method: 'tools/list' }),
});
check('a session id from some other server is ignored rather than refused, because we keep no sessions',
  stale.status === 200, String(stale.status));

stop();
rmSync(DATA, { force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
