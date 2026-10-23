/**
 * The backup model: when Claude cannot answer, NVIDIA's model chooses the tool, so many times per ten days, and then
 * the word rules. Run against a real server with a fake NVIDIA endpoint, so nothing here reaches NVIDIA.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';

const APP = 'sudor';
const P = APP.toUpperCase();
const TOOL = 'warning_signs';
const ARGS = (said) => ({ symptoms: said });

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${String(detail).slice(0, 240)}`); }
};

const { periodCap } = await import('./dist/budget.js');

console.log('\nThe ten-day allowance');
{
  const day = 86_400_000;
  const cap = periodCap(2, 10 * day);
  const t = 20 * day;
  check('two calls fit in the period', cap.take(1, t) && cap.take(1, t + day));
  check('a third does not', cap.take(1, t + 2 * day) === false);
  check('it says when it resets', cap.status(t).resetsAt === new Date(30 * day).toISOString());
  check('ten days on, a new period has room', cap.take(1, t + 10 * day) === true && cap.status(t + 10 * day).used === 1);
}

// A fake NVIDIA: picks the tool for an emergency, chats for "chat", and fails for "fail".
let nvidiaCalls = 0;
const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    nvidiaCalls += 1;
    const body = JSON.parse(raw);
    const said = body.messages[body.messages.length - 1].content;
    if (/fail/.test(said)) { res.writeHead(500); res.end('{}'); return; }
    const message = /chat/.test(said)
      ? { role: 'assistant', content: "I'd be happy to help with that!" }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: TOOL, arguments: JSON.stringify(ARGS(said)) } }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${fake.address().port}/v1/chat/completions`;

const DIR = './data/test-backup';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
const start = async (port, env) => {
  const child = spawn(process.execPath, ['dist/server.js'], {
    env: {
      ...process.env, PORT: String(port), [`${P}_DATA`]: `${DIR}/p-${port}.json`, [`${P}_AUTH_DATA`]: `${DIR}/a-${port}.json`,
      [`${P}_ANTHROPIC_KEY`]: '', ANTHROPIC_API_KEY: '', [`${P}_NVIDIA_KEY`]: 'nvapi-test-not-a-real-key', [`${P}_NVIDIA_URL`]: fakeUrl,
      [`${P}_AGENT_BURST`]: '50', [`${P}_AGENT_PER_MINUTE`]: '600', ...env,
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i += 1) {
    try { await fetch(`${base}/health`); return { child, base }; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('server did not start');
};
const ask = async (base, say) => {
  const r = await fetch(`${base}/agent`, { method: 'POST', headers: { 'content-type': 'application/json', [`x-${APP}-demo`]: randomBytes(16).toString('hex') }, body: JSON.stringify({ say }) });
  return { status: r.status, body: await r.json() };
};

const s = await start(8891, { [`${P}_NVIDIA_MAX`]: '3' });
try {
  console.log('\nClaude has no key, so NVIDIA chooses');
  {
    const r = await ask(s.base, "She's not breathing");
    check('NVIDIA chose the tool, and the tool answered', r.status === 200 && /nemotron/.test(r.body.model) && r.body.chose?.tool === TOOL && r.body.reply.length > 0, JSON.stringify(r.body));
  }
  console.log('\nAnything but a clean choice is the word rules');
  {
    const chat = await ask(s.base, 'chat with me about the weather');
    check('a chat reply from NVIDIA is not said; the word rules answer', chat.status === 200 && chat.body.model === 'word rules', JSON.stringify(chat.body));
    const failed = await ask(s.base, 'this will fail');
    check('an NVIDIA error is not shown; the word rules answer', failed.status === 200 && failed.body.model === 'word rules', JSON.stringify(failed.body));
  }
  console.log('\nThe allowance ends, and NVIDIA is not called again');
  {
    const before = nvidiaCalls;
    const r = await ask(s.base, "She's not breathing");
    check('past the allowance the word rules answer', r.status === 200 && r.body.model === 'word rules', JSON.stringify(r.body));
    check('...and NVIDIA was not called', nvidiaCalls === before, `${before} -> ${nvidiaCalls}`);
    const health = await (await fetch(`${s.base}/health`)).json();
    check('health reports the backup allowance', health.budgets?.backup?.used === 3 && health.budgets?.backup?.limit === 3, JSON.stringify(health.budgets));
  }
} finally {
  s.child.kill();
}

const s2 = await start(8892, { [`${P}_ANTHROPIC_KEY`]: 'sk-ant-test-not-a-real-key' });
try {
  console.log('\nClaude refuses, so NVIDIA chooses');
  {
    const r = await ask(s2.base, "She's not breathing");
    check('a refused Claude key is followed by NVIDIA, with the reason kept', r.status === 200 && /nemotron/.test(r.body.model) && typeof r.body.modelError === 'string', JSON.stringify({ model: r.body.model, modelError: r.body.modelError, ms: r.body.ms }));
  }
} finally {
  s2.child.kill();
  fake.close();
  rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
