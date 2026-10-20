// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
// The model this measures, set before the stand-in loads. The stand-in's own default is Haiku, for the public demo
// page; this golden set and its baseline are Opus, and a run that reported Opus while asking Haiku scored the wrong host.
process.env.SUDOR_AGENT_MODEL ??= 'claude-opus-5-5';
// --core measures the seventeen tools a host is actually shown by default, from evals/golden-core.json; without it,
// every tool, from evals/golden.json. They keep separate baselines, because the two lists are different tests.
const CORE = process.argv.includes('--core');
process.env.SUDOR_SCOPE ??= CORE ? 'core' : 'all';
const SET = CORE ? '-core' : '';
/**
 * A golden evaluation of tool selection.
 *
 * `npm test` proves the server computes the right answer when it is told which
 * tool to run. Nothing in it proves a host would pick that tool from what a
 * customer actually said, and that is the part Amazon's certification list tests:
 * "write clear, unambiguous tool descriptions mapping to distinct customer
 * intents", "include common synonyms, abbreviations and alternate spellings in your
 * tool parameter descriptions and enums", "verify all example utterances work when
 * spoken".
 *
 * A fixed set of utterances, each with the tool a correct host should choose,
 * scored against a model reading this server's real `tools/list`. Every failure is
 * a tool description that did not carry the words somebody used, which is a bug in
 * this repository and not in the model.
 *
 * What it measures, and why each is separate:
 *
 *   Tool accuracy, over every trial. A miss is usually two descriptions that
 *   overlap, or one that does not mention a synonym.
 *
 *   Argument accuracy, over the trials whose case named expected arguments. A miss
 *   is usually an enum that does not list the word people say.
 *
 *   Declining. Cases that expect no tool are scored as their own group with their
 *   own floor, because inventing a tool for "order me a pizza" is a worse
 *   failure than missing one, and a blended number would let a host that always
 *   reaches for something look fine.
 *
 *   pass^k. Every case is run TRIALS times (default 3). A model's choice is a
 *   sample, and a description that works two times in three looks the same as one
 *   that works every time in a single pass. Pass^k is the chance that all k trials
 *   succeed, which is what a customer experiences: they do not get to retry the
 *   sentence the model was unlucky on.
 *
 *   Execution. Whatever the model chose is then actually called, if the tool is
 *   declared read-only, with the arguments it extracted. A choice that scores
 *   right but fails when called is caught here; tools that change state are not
 *   called.
 *
 * Kept run to run: evals/last-run.json every time, and evals/baseline.json when
 * asked (`npm run eval -- --save-baseline`). A case that was stable at the
 * baseline and is not now is listed by sentence, because a score that holds while
 * the cases under it are swapped is not holding.
 *
 * It is an offline golden set: fixed, versioned, run deliberately. It is not a
 * live evaluation, which would sample real sessions, and a golden set cannot
 * notice the thing it does not contain. Add cases from real misses.
 *
 * Costs money: one model call per case per trial, so it is not part of `npm test`.
 * What needs no model (the golden file agreeing with the server, the scorer) is
 * tested by test-golden.mjs, which is.
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every run starts from an empty store in a temporary directory, so the eval can
// neither read nor leave behind anything in the real data directory.
const scratch = mkdtempSync(join(tmpdir(), 'sudor-eval-'));
process.env.SUDOR_DATA = join(scratch, 'people.json');
process.env.SUDOR_AUTH_DATA = join(scratch, 'auth.json');

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { judgeTrial, summarise, compare, validateGolden } from './evals/lib.mjs';

const OUT = process.env.SUDOR_EVAL_OUT ?? './evals';
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const golden = JSON.parse(readFileSync(`./evals/golden${SET}.json`, 'utf8'));
const cases = golden.cases.filter((c) => typeof c.say === 'string');

const { registerTools } = await import('./dist/tools.js');
const agent = await import('./dist/agent.js');

if (!agent.configured()) {
  console.error('SUDOR_ANTHROPIC_KEY (or ANTHROPIC_API_KEY) is not set. The golden eval needs a model to evaluate.');
  process.exit(2);
}

const TRIALS = Math.max(1, Number(opt('--trials', process.env.SUDOR_EVAL_TRIALS ?? 3)));
const PARALLEL = Math.max(1, Number(process.env.SUDOR_EVAL_PARALLEL ?? 4));
/** Floors. Below any of them is a failure rather than a report. */
const FLOOR_ROUTE = Number(process.env.SUDOR_EVAL_FLOOR ?? 0.9);
const FLOOR_DECLINE = Number(process.env.SUDOR_EVAL_FLOOR_DECLINE ?? 0.9);
const FLOOR_ARGS = Number(process.env.SUDOR_EVAL_FLOOR_ARGS ?? 0.85);
/** How far tool accuracy may fall from the baseline before that alone fails the run. */
const MAX_DROP = Number(process.env.SUDOR_EVAL_MAX_DROP ?? 0.03);

const server = new McpServer({ name: 'sudor-eval', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } });
registerTools(server, () => 'eval-person');
const client = new Client({ name: 'golden-eval', version: '0.1.0' }, { capabilities: {} });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);

const tools = (await client.listTools()).tools;
const readOnly = new Set(tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name));

// A golden file that disagrees with the server would produce a score about nothing.
const check = validateGolden(golden, tools);
if (check.problems.length) {
  console.error('The golden file does not match the server:\n  ' + check.problems.join('\n  '));
  process.exit(2);
}

// The same seed for every run, so a score is comparable across runs.
for (const s of golden.seedCalls ?? []) {
  const r = await client.callTool({ name: s.tool, arguments: s.args });
  if (r.isError) {
    console.error(`seed call ${s.tool} failed: ${JSON.stringify(r.content)}`);
    process.exit(2);
  }
}

// --preflight: ask the API to count the tokens of the real request (free) and say what the run
// would cost, without making a model call. It also proves the request is accepted at all, so a
// schema problem is found for nothing instead of after the first paid trial.
if (flag('--preflight')) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const key = process.env.SUDOR_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY;
  const ws = process.env.SUDOR_ANTHROPIC_WORKSPACE;
  const api = new Anthropic({ apiKey: key, ...(ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {}) });
  const req = agent.buildRequest(cases[0].say, tools);
  const counted = await api.messages.countTokens({
    model: req.model,
    system: req.system,
    tools: req.tools,
    tool_choice: req.tool_choice,
    messages: req.messages,
  });
  const model = process.env.SUDOR_AGENT_MODEL ?? 'claude-opus-5-5';
  const [pin, pout] = ({ 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-4-5-20251001': [1, 5] })[model] ?? [4, 20];
  const calls = cases.length * Math.max(1, Number(opt('--trials', process.env.SUDOR_EVAL_TRIALS ?? 3)));
  const inTok = counted.input_tokens;
  // Worst case: nothing is cached. Expected: one cache write, every other call a read.
  // Output is a tool call or a short refusal, so 120 tokens is generous.
  const worst = (calls * (inTok * pin + 120 * pout)) / 1e6;
  const expected = (inTok * pin * 1.25 + (calls - 1) * inTok * pin * 0.1 + calls * 120 * pout) / 1e6;
  console.log(`request accepted: ${inTok} input tokens per call, ${calls} calls on ${model}`);
  console.log(`  worst case, no caching : about $${worst.toFixed(2)}`);
  console.log(`  expected, with caching : about $${expected.toFixed(2)}`);
  process.exit(0);
}

console.log(`${tools.length} tools published, ${cases.length} cases, ${TRIALS} trial${TRIALS === 1 ? '' : 's'} each, model ${process.env.SUDOR_AGENT_MODEL ?? 'claude-opus-5-5'}\n`);

/**
 * The API answers 429 and 529 ("Overloaded") now and then, and a trial that dies on
 * one says nothing about a tool description. Retried with growing waits; anything
 * else, or the last attempt, is reported as an error and fails the run.
 */
async function chooseWithRetry(say) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await agent.choose(say, tools);
    } catch (err) {
      const status = err?.status;
      const transient = status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
      if (!transient || attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt + Math.random() * 500));
    }
  }
}

/** Run one trial of one case: choose, score, and call the tool if it is safe to. */
async function trial(c) {
  let chosen;
  try {
    chosen = await chooseWithRetry(c.say);
  } catch (err) {
    return { toolOk: false, argsChecked: false, argWrong: [], tool: 'ERROR', ms: 0, error: agent.explainError(err), raw: String(err?.message ?? err).slice(0, 300) };
  }
  const judged = judgeTrial(c, chosen);
  const out = { ...judged, tool: chosen.tool, args: chosen.args, ms: chosen.ms, usage: chosen.usage };
  if (chosen.tool && readOnly.has(chosen.tool)) {
    try {
      const r = await client.callTool({ name: chosen.tool, arguments: chosen.args ?? {} });
      const text = (r.content ?? []).map((x) => x.text ?? '').join(' ').trim();
      out.exec = { ok: !r.isError && text.length > 0, detail: r.isError || !text ? text.slice(0, 160) || 'empty answer' : '' };
    } catch (err) {
      out.exec = { ok: false, detail: String(err).slice(0, 160) };
    }
  }
  return out;
}

// What a call costs, per million tokens. Cache writes are 1.25x base input and reads 0.1x
// (Anthropic's published multipliers for the five minute cache). An unknown model is priced
// as Opus, the dearest, so the budget errs toward stopping early.
const PRICES = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-4-5-20251001': [1, 5] };
const MODEL = process.env.SUDOR_AGENT_MODEL ?? 'claude-opus-5-5';
const [PRICE_IN, PRICE_OUT] = PRICES[MODEL] ?? [4, 20];
const BUDGET = Number(opt('--budget', process.env.SUDOR_EVAL_BUDGET ?? 3));
const spent = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
const dollars = () =>
  (spent.input * PRICE_IN + spent.cacheWrite * PRICE_IN * 1.25 + spent.cacheRead * PRICE_IN * 0.1 + spent.output * PRICE_OUT) / 1e6;
let overBudget = false;

async function runJob(r) {
  if (dollars() >= BUDGET) {
    overBudget = true;
    return;
  }
  const tr = await trial(r.case);
  r.trials.push(tr);
  if (tr.usage) {
    spent.calls += 1;
    spent.input += tr.usage.input;
    spent.output += tr.usage.output;
    spent.cacheRead += tr.usage.cacheRead;
    spent.cacheWrite += tr.usage.cacheWrite;
  }
}

// A small pool: the API is the slow part and the cases are independent. The first call
// runs alone, because a cache entry only exists once the first response has begun, and
// four calls started together would each pay to write it.
const results = cases.map((c) => ({ case: c, trials: [] }));
const jobs = results.flatMap((r) => Array.from({ length: TRIALS }, () => r));
let next = 0;
if (jobs.length) await runJob(jobs[next++]);
await Promise.all(
  Array.from({ length: PARALLEL }, async () => {
    while (next < jobs.length && !overBudget) await runJob(jobs[next++]);
  }),
);

await client.close();
await server.close();

if (overBudget) {
  console.error(`Stopped at the budget of $${BUDGET.toFixed(2)} (about $${dollars().toFixed(2)} spent, ${spent.calls} calls). Nothing was scored, because a partial run is not comparable. Raise it with --budget.`);
  process.exit(2);
}

const everyTrial = results.flatMap((r) => r.trials);
if (everyTrial.length && everyTrial.every((t) => t.error)) {
  // Nothing was evaluated. Say why once, rather than listing every sentence as a miss
  // and overwriting the last real report with a run that measured nothing.
  console.error(`Every trial failed, so nothing was scored. First error: ${everyTrial[0].raw ?? everyTrial[0].error}`);
  process.exit(2);
}

const s = summarise(results, TRIALS);

for (const [i, p] of s.perCase.entries()) {
  const mark = p.stable ? 'ok  ' : p.neverRight ? 'MISS' : 'FLKY';
  const r = results[i];
  const argNote = r.trials.find((t) => t.argWrong.length)?.argWrong.map(([k, v]) => `${k} wanted ${JSON.stringify(v)}`).join(', ');
  console.log(`${String(i + 1).padStart(3)} ${mark} ${p.good}/${p.n} ${p.say.slice(0, 54).padEnd(54)} -> ${p.got.join(' | ')}${argNote ? `  [${argNote}]` : ''}`);
}

const allTrials = results.flatMap((r) => r.trials);
const errors = allTrials.filter((t) => t.error);
const meanMs = Math.round(allTrials.reduce((x, t) => x + t.ms, 0) / Math.max(1, allTrials.length));

const routeAcc = s.byKind.route ? s.byKind.route.toolAccuracy : 1;
const declineKinds = Object.entries(s.byKind).filter(([k]) => ['decline', 'adversarial', 'near-domain'].includes(k));
const dTrials = declineKinds.reduce((x, [, v]) => x + v.trials, 0);
const declineAcc = dTrials ? declineKinds.reduce((x, [, v]) => x + v.toolGood, 0) / dTrials : 1;

console.log('\nby kind');
for (const [k, v] of Object.entries(s.byKind)) console.log(`  ${k.padEnd(12)} ${String(v.cases).padStart(3)} cases  ${(v.toolAccuracy * 100).toFixed(1)}%`);
console.log(`\ntool selection : ${(s.toolAccuracy * 100).toFixed(1)}% of ${allTrials.length} trials`);
console.log(`  routing      : ${(routeAcc * 100).toFixed(1)}%`);
console.log(`  declining    : ${(declineAcc * 100).toFixed(1)}%`);
console.log(`arguments      : ${(s.argAccuracy * 100).toFixed(1)}%`);
console.log(`pass^${TRIALS}         : ${(s.passHatK * 100).toFixed(1)}%  (${s.stableCases} stable, ${s.flakyCases} flaky, ${s.neverRightCases} never right, of ${s.cases})`);
console.log(`execution      : ${s.execution.ran - s.execution.failed}/${s.execution.ran} chosen read-only calls answered`);
console.log(`mean decision  : ${meanMs} ms`);
const hitShare = spent.cacheRead / Math.max(1, spent.cacheRead + spent.cacheWrite + spent.input);
console.log(`cost           : about $${dollars().toFixed(2)} for ${spent.calls} calls on ${MODEL} (${(hitShare * 100).toFixed(0)}% of input tokens read from cache)`);

const execFails = allTrials.filter((t) => t.exec && !t.exec.ok);
if (errors.length) console.log(`\n${errors.length} trials errored, first: ${errors[0].error} | ${errors[0].raw}`);
if (execFails.length) {
  console.log('\nChosen tools that failed when called:');
  for (const t of execFails.slice(0, 8)) console.log(`  ${t.tool} ${JSON.stringify(t.args)}  ${t.exec.detail}`);
}
const bad = s.perCase.filter((p) => !p.stable);
if (bad.length) {
  console.log('\nEvery line below is a tool description that did not carry the words somebody used:');
  for (const p of bad) console.log(`  "${p.say}"\n     wanted ${p.want ?? 'no tool'}, got ${p.got.join(' | ')}  (${p.good}/${p.n} trials right)`);
}

const report = {
  at: new Date().toISOString(),
  model: MODEL,
  costUsd: Number(dollars().toFixed(4)),
  trials: TRIALS,
  toolCount: tools.length,
  routeAccuracy: routeAcc,
  declineAccuracy: declineAcc,
  ...s,
};
writeFileSync(join(OUT, `last-run${SET}.json`), JSON.stringify(report, null, 2));
if (flag('--save-baseline')) {
  writeFileSync(join(OUT, `baseline${SET}.json`), JSON.stringify(report, null, 2));
  console.log('\nsaved evals/baseline' + SET + '.json');
}

let before = null;
if (existsSync(join(OUT, `baseline${SET}.json`)) && !flag('--save-baseline')) {
  before = JSON.parse(readFileSync(join(OUT, `baseline${SET}.json`), 'utf8'));
}
const cmp = compare(report, before);
if (cmp.hadBaseline) {
  console.log(`\nagainst the baseline of ${before.at.slice(0, 10)}: tool accuracy ${cmp.drop > 0 ? 'down' : 'up'} ${(Math.abs(cmp.drop) * 100).toFixed(1)} points, ${cmp.regressions.length} regressed, ${cmp.fixed.length} fixed`);
  for (const r of cmp.regressions) console.log(`  REGRESSED "${r.say}"  ${r.was} -> ${r.now}  got ${r.got.join(' | ')}`);
}

const failures = [];
if (routeAcc < FLOOR_ROUTE) failures.push(`routing ${(routeAcc * 100).toFixed(1)}% is under ${(FLOOR_ROUTE * 100).toFixed(0)}%`);
if (declineAcc < FLOOR_DECLINE) failures.push(`declining ${(declineAcc * 100).toFixed(1)}% is under ${(FLOOR_DECLINE * 100).toFixed(0)}%`);
if (s.argAccuracy < FLOOR_ARGS) failures.push(`arguments ${(s.argAccuracy * 100).toFixed(1)}% is under ${(FLOOR_ARGS * 100).toFixed(0)}%`);
if (s.execution.failed > 0) failures.push(`${s.execution.failed} chosen read-only calls failed`);
if (errors.length) failures.push(`${errors.length} trials could not be scored`);
if (cmp.regressions.length) failures.push(`${cmp.regressions.length} case${cmp.regressions.length === 1 ? '' : 's'} that were stable at the baseline are not now`);
if (cmp.hadBaseline && cmp.drop > MAX_DROP) failures.push(`tool accuracy fell ${(cmp.drop * 100).toFixed(1)} points from the baseline`);

console.log(failures.length ? `\nFAIL\n  ${failures.join('\n  ')}\n` : '\nPASS\n');
process.exit(failures.length ? 1 : 0);
