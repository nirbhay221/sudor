// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * The voice budget, measured rather than asserted.
 *
 * A voice turn is roughly half a second end to end, and the add-on is one part
 * of that. One Open-Meteo call takes about that long on its own, which is why
 * every registered place is polled on a timer and every answer is served from
 * memory. This measures that claim and fails the build if it stops being true.
 *
 * Two budgets, because two different things are being promised:
 *   - answers from the polled forecast: p95 under 50 ms
 *   - the first recall check, which reaches openFDA: p95 under 3 s, cached after
 *
 * Numbers from the last run are written to LATENCY.md.
 */
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 8794;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = './data/test-latency.json';
const ROUNDS = Number(process.env.ROUNDS ?? 20);
// A shared CI runner is slower and noisier than a laptop, so the budget is
// overridable there. The number in LATENCY.md is always the one measured on
// the machine that ran it, not the budget it was checked against.
const MEMORY_BUDGET_MS = Number(process.env.LATENCY_BUDGET_MS ?? 50);
const NETWORK_BUDGET_MS = 3000;
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
// The budget is for answers in steady running. The cooling-centre and outage lists are read once at start and then
// every half hour, so the measuring starts once that first read is done, or after half a minute whatever happens.
for (let i = 0; i < 60; i++) {
  const health = await (await fetch(`${BASE}/health`)).json().catch(() => ({}));
  if (Object.keys(health.coolingCentres ?? {}).length >= 16) break;
  await wait(500);
}

let rpcId = 0;
async function call(name, args = {}) {
  const started = process.hrtime.bigint();
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-sudor-demo': '2d22c53a3dc7b9fead2dab7f2b602f67',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  const body = JSON.parse(line ? line.slice(6) : raw);
  return { ms, ok: !body.error && !!body.result?.content?.[0]?.text };
}

// A real place, and the few seconds a first visit also takes while the forecast,
// the air quality and the weather service warnings are fetched in the background.
await call('register_location', { place: 'Phoenix, Arizona', lat: 33.45, lon: -112.07 });
await call('medication', { action: 'add', name: 'lisinopril' });
await call('medication', { action: 'add', name: 'hydrochlorothiazide' });
await call('health_condition', { action: 'add', condition: 'heart disease' });
await wait(8000);

const MEMORY = {
  weather_check: {},
  plan_my_day: { activity: 'a walk', minutes: 45 },
  going_out_now: {},
  warning_signs: { symptoms: 'dizzy and thirsty' },
  should_i_shovel: {},
  weather_warnings: {},
  storm_prep: {},
  sun_check: {},
  my_profile: {},
  what_can_you_do: {},
  log_outing: { felt: 'fine', minutes: 20 },
};
const NETWORK = { medicine_recalls: {} };

const pct = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))];
const rows = [];

async function measure(name, args, budget, kind) {
  const times = [];
  for (let i = 0; i < ROUNDS; i++) times.push((await call(name, args)).ms);
  const row = { name, kind, p50: pct(times, 50), p95: pct(times, 95), max: Math.max(...times), budget };
  rows.push(row);
  check(`${name} p95 ${row.p95.toFixed(1)} ms, under ${budget} ms`, row.p95 < budget,
    `p50 ${row.p50.toFixed(1)} p95 ${row.p95.toFixed(1)} max ${row.max.toFixed(1)}`);
}

console.log(`\nAnswers held in memory, ${ROUNDS} calls each`);
for (const [name, args] of Object.entries(MEMORY)) await measure(name, args, MEMORY_BUDGET_MS, 'memory');

console.log('\nThe recall check, which reaches openFDA on the first call of the day');
const firstRecall = await call('medicine_recalls', {});
check(`the first recall check answers in ${firstRecall.ms.toFixed(0)} ms, under ${NETWORK_BUDGET_MS} ms`,
  firstRecall.ms < NETWORK_BUDGET_MS, `${firstRecall.ms.toFixed(0)} ms`);
for (const [name, args] of Object.entries(NETWORK)) await measure(name, args, MEMORY_BUDGET_MS, 'cached');

console.log('\nThe whole turn, one after another');
const sequence = ['weather_check', 'plan_my_day', 'going_out_now'];
const wholeTurn = [];
for (let i = 0; i < ROUNDS; i++) {
  const started = process.hrtime.bigint();
  for (const name of sequence) await call(name, MEMORY[name]);
  wholeTurn.push(Number(process.hrtime.bigint() - started) / 1e6);
}
check(`three tools in one turn, p95 ${pct(wholeTurn, 95).toFixed(1)} ms, under 150 ms`, pct(wholeTurn, 95) < 150,
  `p50 ${pct(wholeTurn, 50).toFixed(1)}`);

const worst = rows.reduce((a, b) => (a.p95 > b.p95 ? a : b));
writeFileSync(
  'LATENCY.md',
  `# Latency\n\n` +
    `Measured by \`node test-latency.mjs\`, ${ROUNDS} calls per tool, over HTTP against the built\n` +
    `server on this machine, for a profile in Phoenix with two medications and one condition, with\n` +
    `the forecast already polled. Node ${process.version}. ` +
    `Last run ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.\n\n` +
    `A voice turn is roughly half a second in total, and the add-on is one part of that.\n` +
    `Everything below is the server's own share, from request received to response written.\n\n` +
    `| tool | source | p50 ms | p95 ms | max ms | budget |\n|---|---|---|---|---|---|\n` +
    rows
      .map((r) => `| \`${r.name}\` | ${r.kind} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.max.toFixed(1)} | ${r.budget} |`)
      .join('\n') +
    `\n\nThree tools called one after another, as a single turn might: p50 ` +
    `${pct(wholeTurn, 50).toFixed(1)} ms, p95 ${pct(wholeTurn, 95).toFixed(1)} ms.\n\n` +
    `The slowest answer here is \`${worst.name}\` at ${worst.p95.toFixed(1)} ms p95. The first\n` +
    `\`medicine_recalls\` of the day took ${firstRecall.ms.toFixed(0)} ms because it reaches openFDA;\n` +
    `it is cached for twelve hours after that, and a failed check is never cached as an all clear.\n`,
);
console.log('\nwrote LATENCY.md');

stop();
rmSync(DATA, { force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
