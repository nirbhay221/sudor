// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * The certification contract, checked against a running server.
 *
 * Amazon's functional requirements for add-ons are specific and testable, and
 * three of them are about the tool surface rather than about any one answer:
 *
 *   "Every tool returned by your server's tools/list endpoint must be invocable"
 *   "Your server must gracefully handle unexpected or invalid parameters"
 *   "Surface no API codes, tool names, JSON, or internal IDs in any
 *    customer-facing response"
 *
 * So this walks tools/list, calls every tool on it for real against a real
 * place, reads what comes back the way a customer would hear it, then sends
 * each one arguments it never asked for and checks the refusal is in English
 * and the server is still answering. The tool list is not written down here: a
 * tool added later and forgotten is exactly the failure this catches.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = './data/test-contract.json';
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
async function rpc(method, params, session = '9da1d202c3254add05ca39329cac11bd') {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-sudor-demo': session,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const raw = await res.text();
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  return { status: res.status, body: JSON.parse(line ? line.slice(6) : raw) };
}
const callTool = (name, args, session) => rpc('tools/call', { name, arguments: args }, session);

/**
 * Arguments a real customer's words would produce, one set per tool.
 *
 * A real place, real medicines, a real condition. The sweep fails if a tool
 * appears in tools/list without an entry here, so this cannot quietly fall
 * behind the server.
 */
const SPOKEN = {
  register_location: { place: 'Phoenix, Arizona', lat: 33.45, lon: -112.07 },
  medication: { action: 'add', name: 'lisinopril' },
  health_condition: { action: 'add', condition: 'heart disease' },
  my_profile: {},
  set_privacy: { on: false },
  contact: { action: 'add', name: 'Priya', email: 'priya@example.com', relation: 'daughter' },
  log_outing: { felt: 'fine', minutes: 20 },
  weather_check: {},
  plan_my_day: { activity: 'a walk', minutes: 45, day: 'today' },
  going_out_now: {},
  warning_signs: { symptoms: 'a bit dizzy and very thirsty' },
  should_i_shovel: {},
  weather_warnings: {},
  storm_prep: {},
  sun_check: {},
  medicine_recalls: {},
  somewhere_to_go: {},
  what_can_you_do: {},
  share_my_day: { action: 'invite' },
  check_on: {},
  get_help: { what: 'the power is out and I am cold' },
  tell_me_more: {},
  plan_my_week: { activity: 'gardening', workStart: 9, workEnd: 17 },
  heat_patterns: { period: 'week' },
  doctor_plan: { action: 'add', says: 'on hot days take my water pill in the morning' },
  my_trips: { action: 'list' },
  household: { action: 'add', called: 'Mum', age: 82, medicines: ['Lasix'] },
};

/** Nothing can be answered for a person until there is a person and a place. */
const FIRST = ['register_location', 'medication', 'health_condition'];

console.log('\nEvery tool on tools/list is invocable');
const listed = (await rpc('tools/list', {})).body.result?.tools ?? [];
check('tools/list answers with tools', listed.length > 0, JSON.stringify(listed).slice(0, 120));

const names = listed.map((t) => t.name);
const missing = names.filter((n) => !(n in SPOKEN));
check('every listed tool has a real request written for it here', !missing.length, missing.join(', '));

for (const name of names) check(`${name} declares an input schema`, !!listed.find((t) => t.name === name)?.inputSchema);

console.log('\nWhat each tool says it does to the world');
const ann = (n) => listed.find((t) => t.name === n)?.annotations;
const unannotated = names.filter((n) => !ann(n));
check('every tool declares its annotations', !unannotated.length, unannotated.join(', '));
const destructive = names.filter((n) => ann(n)?.destructiveHint).sort();
check('...and the destructive ones are exactly the ones that take something away',
  JSON.stringify(destructive) === JSON.stringify(['contact', 'health_condition', 'medication', 'my_profile']), destructive.join(', '));
/*
 * The duplicate-write bug, turned into an invariant. A tool that writes and is
 * not idempotent has to be a deliberate decision, named here, rather than
 * something that slipped in unnoticed.
 */
const repeatable = names.filter((n) => ann(n)?.readOnlyHint === false && ann(n)?.idempotentHint !== true).sort();
// share_my_day is the third: asking for a code twice gives two codes on purpose, and only the newer one works.
// get_help is the fourth: somebody who asks for help twice means it twice, and the hourly cap is what stops a flood.
check('...and every writing tool folds a repeat, except the four we chose',
  JSON.stringify(repeatable) === JSON.stringify(['contact', 'get_help', 'share_my_day', 'warning_signs']), repeatable.join(', '));
const openWorld = names.filter((n) => ann(n)?.openWorldHint).length;
check('...and the tools that depend on the outside world say so', openWorld >= 9, String(openWorld));

console.log('\nA customer who has told us nothing yet');
/*
 * The first thing a certifier does is open the add-on and start talking, before
 * registering anything. The sister project to this one was asked for a status
 * in exactly that state and read the exception itself back out loud, "Cannot
 * read properties of undefined", so every tool is asked on an empty profile
 * here. It is the state every customer starts in.
 */
const emptyAnswers = {};
for (const name of names) {
  if (!(name in SPOKEN)) continue;
  const { status, body } = await callTool(name, {}, 'emptyperson1');
  const text = body.result?.content?.[0]?.text ?? '';
  emptyAnswers[name] = text;
  const broke = /Cannot read|undefined|not a function|at Object\.|TypeError|Error:/.test(text);
  check(`${name} answers before anything is registered`,
    status === 200 && !body.error && text.trim().length > 0 && !broke,
    body.error ? JSON.stringify(body.error).slice(0, 140) : `${status} ${text.slice(0, 140)}`);
}
for (const [name, text] of Object.entries(emptyAnswers)) {
  // "Provide actionable next step for every error": an empty profile is not an
  // error, but it is a dead end unless the answer says what to say next.
  const empty = /don't have|not registered|no fields|no equipment|nothing|tell me|ask me|give me|first|yet/i.test(text);
  check(`${name} says what to do next rather than stopping dead`, empty || text.length > 60, text.slice(0, 140));
}

// The place is registered first and the forecast fetched in the background, so
// give it the few seconds a real first visit would also take.
const order = [...FIRST.filter((n) => names.includes(n)), ...names.filter((n) => !FIRST.includes(n))];
await callTool('register_location', SPOKEN.register_location);
await wait(6000);

const spoken = {};
for (const name of order) {
  if (!(name in SPOKEN)) continue;
  const { status, body } = await callTool(name, SPOKEN[name]);
  const text = body.result?.content?.[0]?.text ?? '';
  spoken[name] = text;
  check(`${name} answers`, status === 200 && !body.error && text.trim().length > 0,
    body.error ? JSON.stringify(body.error).slice(0, 140) : `${status} empty`);
}

console.log('\nA place registered, but no medicines or conditions yet');
await callTool('register_location', SPOKEN.register_location, 'halfsetup01');
await wait(6000);
for (const name of names) {
  // Adding a medicine or a condition would end the very state being tested.
  if (name === 'medication' || name === 'health_condition') continue;
  const { status, body } = await callTool(name, SPOKEN[name] ?? {}, 'halfsetup01');
  const text = body.result?.content?.[0]?.text ?? '';
  check(`${name} answers with a place but no health details`,
    status === 200 && !body.error && text.trim().length > 0 && !/Cannot read|undefined|TypeError/.test(text),
    `${status} ${text.slice(0, 140)}`);
}

console.log('\nNothing a customer hears is written for a developer');
for (const [name, text] of Object.entries(spoken)) {
  const leak =
    /[{}]/.test(text) ? 'JSON braces' :
    /undefined|NaN|\[object Object\]/.test(text) ? 'a broken value' :
    /\bjsonrpc\b|\bHTTP \d\d\d|MCP error/.test(text) ? 'a protocol detail' :
    /_[a-z]+_|\b(heat_exhaustion|hot_day|reduced_sweating|older_adult)\b/.test(text) ? 'an internal id' : '';
  check(`${name} says nothing internal`, !leak, `${leak}: ${text.slice(0, 120)}`);
}

console.log('\nSentences that would sound wrong out loud');
for (const [name, text] of Object.entries(spoken)) {
  const stumble =
    /\b(so|and|but|then) \1\b/i.test(text) ? 'a doubled connective' :
    /\bso and\b|\band so\b(?! much)/i.test(text) ? 'two connectives in a row' :
    /\bcan also can\b|\bthe the\b|\ba a\b/i.test(text) ? 'a doubled word' :
    /\.\s*\./.test(text) ? 'a doubled full stop' :
    /\s,|,,/.test(text) ? 'a stray comma' : '';
  check(`${name} reads cleanly`, !stumble, `${stumble}: ${text.slice(0, 140)}`);
}

console.log('\nArguments no tool asked for');
for (const name of names) {
  const { status, body } = await callTool(name, { nonsense: '?!', felt: 12345, action: 'explode', on: 'maybe' }, 'contractaa02');
  const text = body.result?.content?.[0]?.text ?? '';
  const refusedCleanly = !!body.error && status === 200;
  const answeredAnyway = !body.error && text.trim().length > 0;
  check(`${name} survives junk arguments`, refusedCleanly || answeredAnyway,
    `${status} ${JSON.stringify(body).slice(0, 140)}`);
}

console.log('\nArguments named after the language itself');
for (const name of names) {
  const { status, body } = await callTool(name, { constructor: 'x', prototype: 'y', nonsense: '?' }, 'contractaa02');
  check(`${name} answers an argument named "constructor" instead of an internal error`,
    status === 200 && body.error?.code !== -32603, `${status} ${JSON.stringify(body).slice(0, 140)}`);
}
const nested = await callTool(names[0], { nested: { constructor: 'x' } }, 'contractaa02');
check('a nested one is handled the same way', nested.body.error?.code !== -32603, JSON.stringify(nested.body).slice(0, 140));

const wrongWord = await callTool('medication', { action: 'explode', name: 'lisinopril' }, 'contractaa02');
const wrongText = wrongWord.body.result?.content?.[0]?.text ?? '';
check('a word we do not know is answered with the words we do know', /I can do add, remove/.test(wrongText), wrongText);
check('...and the word it could not use is never offered back as a choice', !/explode/.test(wrongText), wrongText);
const missingDetail = await callTool('medication', { action: 'add' }, 'contractaa02');
check('a missing detail asks for it again rather than quoting the protocol',
  !/MCP error|validation/i.test(missingDetail.body.result?.content?.[0]?.text ?? ''),
  missingDetail.body.result?.content?.[0]?.text ?? '');

const afterJunk = await callTool('weather_check', {});
check('and the server is still answering after all of that',
  !afterJunk.body.error && (afterJunk.body.result?.content?.[0]?.text ?? '').length > 0);

console.log('\nA request that is not a tool call at all');
const nonsense = await rpc('tools/call', { name: 'no_such_tool', arguments: {} });
const nonsenseText = nonsense.body.result?.content?.[0]?.text ?? '';
check('an unknown tool name is refused, not a crash',
  !!nonsense.body.error || nonsense.body.result?.isError === true, JSON.stringify(nonsense.body).slice(0, 140));
check('...in words, with somewhere to go next, and no protocol in them',
  !/MCP error|-32\d\d\d|no_such_tool/.test(nonsenseText) && /ask me/i.test(nonsenseText), nonsenseText);
const badMethod = await rpc('resources/list', {});
check('a method this server does not implement is answered, not hung',
  badMethod.status === 200 && (!!badMethod.body.error || !!badMethod.body.result), JSON.stringify(badMethod.body).slice(0, 140));


console.log('\nOne caller cannot spend everyone else\'s share');
/*
 * The specification asks servers to rate limit tool invocations, and this
 * endpoint is public. A second server is started with a tiny bucket, because
 * the real one is set high enough that a voice conversation never meets it.
 */
const limitedPort = 8788;
const limited = spawn(process.execPath, ['dist/server.js'], {
  env: {
    ...process.env,
    PORT: String(limitedPort),
    SUDOR_DATA: './data/test-ratelimit.json',
    SUDOR_AUTH: 'off',
    SUDOR_BURST: '5',
    SUDOR_REFILL: '0',
    // One proxy hop, so X-Forwarded-For can stand in for two different callers. Sandbox
    // callers are charged by address: a demo id is free to invent and cannot be a key.
    SUDOR_TRUST_PROXY: '1',
  },
  stdio: 'ignore',
});
try {
  let limitedUp = false;
  for (let i = 0; i < 60 && !limitedUp; i++) {
    try { limitedUp = (await fetch(`http://127.0.0.1:${limitedPort}/health`)).ok; } catch { await wait(500); }
  }
  const hit = async () => {
    const res = await fetch(`http://127.0.0.1:${limitedPort}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-forwarded-for': '203.0.113.10', 'x-sudor-demo': 'ee74208ad57ec4a74674a4945ab22e9e' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'what_can_you_do', arguments: {} } }),
    });
    return res.status;
  };
  const statuses = [];
  for (let i = 0; i < 8; i++) statuses.push(await hit());
  check('the first few calls are served', statuses.slice(0, 5).every((s) => s === 200), statuses.join(','));
  check('...and then the caller is turned away rather than served forever',
    statuses.slice(5).some((s) => s === 429), statuses.join(','));
  const refused = await fetch(`http://127.0.0.1:${limitedPort}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-forwarded-for': '203.0.113.10', 'x-sudor-demo': 'ee74208ad57ec4a74674a4945ab22e9e' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'what_can_you_do', arguments: {} } }),
  });
  check('...with a retry hint rather than a closed door', !!refused.headers.get('retry-after'), String(refused.status));
  const body = await refused.json();
  check('...and the refusal is in words, not a stack trace',
    /slow down/i.test(body.error?.message ?? '') && !/Error:|at /.test(body.error?.message ?? ''), JSON.stringify(body).slice(0, 120));
  // The bypass this closes: from the SAME address, a fresh demo id must not reset the
  // limit, because inventing one costs nothing.
  const rotated = await fetch(`http://127.0.0.1:${limitedPort}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-forwarded-for': '203.0.113.10', 'x-sudor-demo': 'b3f1a9c2d4e5f60718293a4b5c6d7e8f' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'what_can_you_do', arguments: {} } }),
  });
  check('a fresh demo id from the same address is still limited', rotated.status === 429, String(rotated.status));
  // A different address has its own bucket and is unaffected.
  const otherRes = await fetch(`http://127.0.0.1:${limitedPort}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-forwarded-for': '203.0.113.20', 'x-sudor-demo': '7c4c1db8ad9f3bb4266e7629a9c34875' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'what_can_you_do', arguments: {} } }),
  });
  check('a caller at a different address is not punished for the first one', otherRes.status === 200, String(otherRes.status));
} finally {
  try { limited.kill(); } catch { /* already gone */ }
  rmSync('./data/test-ratelimit.json', { force: true });
}


console.log('\nGoing down on purpose');
/*
 * systemd sends SIGTERM on every redeploy. Without a handler the process dies
 * where it stands. Windows does not deliver the signal to a Node handler at
 * all, so this runs where it means something and says so where it does not.
 */
if (process.platform === 'win32') {
  console.log('  skip  SIGTERM is not delivered to a handler on Windows; CI runs this on Linux');
} else {
  const victim = spawn(process.execPath, ['dist/server.js'], {
    env: { ...process.env, PORT: '8785', SUDOR_DATA: './data/test-shutdown.json', SUDOR_AUTH: 'off' },
    stdio: 'ignore',
  });
  let alive = false;
  for (let i = 0; i < 60 && !alive; i++) {
    try { alive = (await fetch('http://127.0.0.1:8785/health')).ok; } catch { await wait(500); }
  }
  check('the server came up to be shut down', alive);
  const started = Date.now();
  const exited = await new Promise((resolve) => {
    victim.on('exit', (code) => resolve({ code, ms: Date.now() - started }));
    victim.kill('SIGTERM');
    setTimeout(() => resolve({ code: 'still running', ms: Date.now() - started }), 8000);
  });
  check('SIGTERM stops it cleanly rather than killing it mid request',
    exited.code === 0 && exited.ms < 8000, JSON.stringify(exited));
  rmSync('./data/test-shutdown.json', { force: true });
}

stop();
rmSync(DATA, { force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
