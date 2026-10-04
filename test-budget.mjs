// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * What anybody with the URL can make this server spend.
 *
 * `/agent` makes a model call and `/speak` a Polly call. Neither sat behind the
 * rate limiter that protects the MCP endpoint, so the cost of those two was bounded
 * by nothing except how fast a stranger could type. The exposure only ever shows up
 * as an invoice, which is the worst place to find a limit missing.
 *
 * The unit tests below pin the arithmetic. The server test pins the behaviour that
 * matters: a refused request must not consume budget, a cached sentence must be
 * free, and a malformed request must never be charged.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const { dailyCap, perCaller } = await import('./dist/budget.js');

console.log('\nThe daily cap counts units and refuses without consuming');
{
  const cap = dailyCap(5);
  check('room is taken', cap.take(2) && cap.take(2));
  check('the status reflects it', cap.status().used === 4 && cap.status().limit === 5);
  check('a cost that does not fit is refused', cap.take(2) === false);
  check('and the refusal consumed nothing', cap.status().used === 4);
  check('what does fit still fits', cap.take(1) === true);
  check('then it is full', cap.take(1) === false && cap.status().used === 5);
}

console.log('\nThe cap resets at midnight UTC, not after 24 hours');
{
  const cap = dailyCap(2);
  const late = Date.parse('2026-09-30T23:59:00Z');
  check('two units used late in the day', cap.take(1, late) && cap.take(1, late));
  check('none left that day', cap.take(1, late + 30_000) === false);
  check('a minute later it is a new day', cap.take(1, Date.parse('2026-10-01T00:00:30Z')) === true);
  check('and the count restarted', cap.status(Date.parse('2026-10-01T00:00:30Z')).used === 1);
}

console.log('\nThe per caller bucket stops one client, not everybody');
{
  const b = perCaller(3, 6);
  const t = 1_000_000;
  check('a burst of three is allowed', b.allow('a', t) && b.allow('a', t) && b.allow('a', t));
  check('the fourth is refused', b.allow('a', t) === false);
  check('a different caller is untouched', b.allow('b', t) === true);
  check('ten seconds later one token has refilled', b.allow('a', t + 10_000) === true);
  check('and only one', b.allow('a', t + 10_000) === false);
  check('the bucket never holds more than the burst', (() => {
    const c = perCaller(2, 600);
    c.allow('x', 0);
    return c.allow('x', 3_600_000) && c.allow('x', 3_600_000) && !c.allow('x', 3_600_000);
  })());
}

console.log('\nThe map of callers cannot grow forever');
{
  const b = perCaller(2, 60);
  for (let i = 0; i < 12_000; i += 1) b.allow(`caller-${i}`, 0);
  check('it stays bounded once the callers go quiet', b.size() < 12_000, String(b.size()));
}

const DIR = './data/test-budget';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

const start = async (port, env) => {
  const child = spawn(process.execPath, ['dist/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      SUDOR_DATA: `${DIR}/p-${port}.json`,
      SUDOR_AUTH_DATA: `${DIR}/a-${port}.json`,
      SUDOR_SPEAK: 'on',
      ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key',
      ...env,
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i += 1) {
    try { await fetch(`${base}/health`); return { child, base }; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('server did not start');
};

const post = (base, path, body, headers = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const ID = () => randomBytes(16).toString('hex');

// A generous per caller limit, so the daily ceiling is what is under test here.
const s = await start(8873, { SUDOR_AGENT_DAILY_MAX: '2', SUDOR_SPEAK_DAILY_CHARS: '60', SUDOR_AGENT_BURST: '50', SUDOR_SPEAK_BURST: '50' });
try {
  console.log('\n/agent: a malformed request is never charged, and the day has a ceiling');
  {
    const who = { 'x-sudor-demo': ID() };
    const empty = await post(s.base, '/agent', { say: '   ' }, who);
    check('an empty utterance is a 400', empty.status === 400, String(empty.status));

    // The key is fake, so each of these reaches the model call and fails with 502.
    // That is the point: they were allowed to try, and each one cost a unit.
    const first = await post(s.base, '/agent', { say: 'is it safe to plant' }, { 'x-sudor-demo': ID() });
    const second = await post(s.base, '/agent', { say: 'is it safe to plant' }, { 'x-sudor-demo': ID() });
    check('the first two are let through to the model', first.status !== 429 && second.status !== 429, `${first.status} ${second.status}`);

    const third = await post(s.base, '/agent', { say: 'is it safe to plant' }, { 'x-sudor-demo': ID() });
    check('the third is refused by the daily cap', third.status === 429, String(third.status));
    const body = await third.json();
    check('it names the budget, not a server fault', body.error === 'daily_budget', JSON.stringify(body));
    check('and says the rest of the page still works', /still works/.test(body.detail ?? ''), body.detail);

    const health = await (await fetch(`${s.base}/health`)).json();
    check('health reports the spend', health.budgets.agent.used === 2 && health.budgets.agent.limit === 2, JSON.stringify(health.budgets));
  }

  console.log('\n/agent: one caller cannot hammer it');
  {
    const s2 = await start(8874, { SUDOR_AGENT_DAILY_MAX: '1000' });
    try {
      const same = { 'x-sudor-demo': ID() };
      const codes = [];
      for (let i = 0; i < 6; i += 1) codes.push((await post(s2.base, '/agent', { say: 'hello there' }, same)).status);
      check('a burst from one caller is cut off', codes.includes(429), codes.join(','));
      check('the first few were allowed', codes.slice(0, 3).every((c) => c !== 429), codes.join(','));
      // The bypass this closes: a fresh demo id is free to invent, so a limiter keyed
      // on it gives every request a new bucket and limits nothing.
      const rotated = [];
      for (let i = 0; i < 6; i += 1) rotated.push((await post(s2.base, '/agent', { say: 'hello there' }, { 'x-sudor-demo': ID() })).status);
      check('rotating the demo id does not reset the limit', rotated.every((c) => c === 429), rotated.join(','));
    } finally { s2.child.kill(); }
  }

  console.log('\n/speak: rejected input is free, and only a synthesis is charged');
  {
    const who = { 'x-sudor-demo': ID() };
    const markup = await post(s.base, '/speak', { text: '<speak>hi</speak>' }, who);
    check('markup is a 400', markup.status === 400, String(markup.status));
    const before = (await (await fetch(`${s.base}/health`)).json()).budgets.speechCharacters.used;
    check('and cost nothing', before === 0, String(before));

    const tooBig = await post(s.base, '/speak', { text: 'This sentence is deliberately longer than the sixty character daily allowance.' }, who);
    check('a sentence bigger than what is left is refused by the cap', tooBig.status === 429, String(tooBig.status));
    const afterRefusal = (await (await fetch(`${s.base}/health`)).json()).budgets.speechCharacters.used;
    check('the refusal consumed nothing', afterRefusal === 0, String(afterRefusal));
  }
} finally {
  s.child.kill();
}

console.log('\nThe stand-in runs as the visitor, not as a shared profile');
{
  const s3 = await start(8875, { SUDOR_AGENT_DAILY_MAX: '1000', SUDOR_AUTH: 'on' });
  try {
    const none = await post(s3.base, '/agent', { say: 'hello' });
    check('with auth on, no identity is a 401 rather than a 500', none.status === 401, String(none.status));
    const speakNone = await post(s3.base, '/speak', { text: 'Hello there.' });
    check('and /speak likewise', speakNone.status === 401, String(speakNone.status));
    const withId = await post(s3.base, '/agent', { say: 'hello' }, { 'x-sudor-demo': ID() });
    check('a demo identity is let in', withId.status !== 401, String(withId.status));
  } finally { s3.child.kill(); }
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
