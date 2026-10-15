/**
 * Whole conversations, played against the real tools a turn at a time.
 *
 * eval.mjs asks one sentence and scores one choice. People do not talk in single sentences. They say "and
 * tomorrow?" after an answer, "no, I meant spraying", "why not", the same thing twice when the first answer did
 * not land, and "never mind". Recorded studies of people using voice assistants at home found that most
 * breakdowns are exactly there: in the turn that depends on the one before (see evals/conversations.json).
 *
 * So each conversation in evals/conversations.json is played in order. For every turn the model sees the
 * earlier turns and what the add-on actually answered to them, the way a host keeps a conversation. Whatever it
 * chooses is then really called, for a fresh person in a temporary store on a dangerous day, and that answer
 * becomes part of what the next turn sees. A turn is right when the tool is the one expected (or one of the
 * reasonable ones), when it declines where it should, and when the arguments named in the file match.
 *
 *   node conversations.mjs                 Opus, every conversation once. Costs money: one call per turn.
 *   node conversations.mjs --budget 0.6    stops before spending more than that
 *   node conversations.mjs --only "why"    only conversations whose name contains that
 *
 * With no key it says so and stops. test-conversations.mjs runs the same code against a scripted host, for free.
 */
process.env.SUDOR_AGENT_MODEL ??= 'claude-opus-5-5';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'sudor-conv-'));
process.env.SUDOR_DATA = join(scratch, 'people.json');
process.env.SUDOR_AUTH_DATA = join(scratch, 'auth.json');
process.env.SUDOR_OUTBOX = join(scratch, 'outbox.jsonl');
delete process.env.SUDOR_SCOPE;
delete process.env.SUDOR_DATA_KEY;

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

export const FILE = JSON.parse(readFileSync(new URL('./evals/conversations.json', import.meta.url), 'utf8'));
const PRICES = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-4-5-20251001': [1, 5] };

/** The day the conversations happen on: a 110 degree day in Phoenix with a night that stays at 90. Nothing reaches the network. */
async function seedWorld() {
  // Only the model is reached. Every feed the tools read is seeded or left empty.
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (/^https:\/\/api\.anthropic\.com\//.test(String(url instanceof Request ? url.url : url))) return real(url, init);
    throw new Error('offline in the conversation eval');
  };
  const weather = await import('./dist/weather.js');
  const shelters = await import('./dist/shelters.js');
  const cooling = await import('./dist/cooling.js');
  const outages = await import('./dist/outages.js');
  shelters.seedForTest([]);
  cooling.configureForTest(async () => []);
  outages.configureForTest(async () => []);
  let shift = 12 - new Date().getUTCHours();
  if (shift > 14) shift -= 24;
  if (shift < -11) shift += 24;
  const off = shift * 3600;
  const local = (ms) => new Date(ms + off * 1000).toISOString();
  const today = local(Date.now()).slice(0, 10);
  const hourly = [];
  for (let d = 0; d < 2; d += 1) {
    const date = local(Date.now() + d * 86_400_000).slice(0, 10);
    for (let h = 0; h < 24; h += 1) {
      const at = `${date}T${String(h).padStart(2, '0')}:00`;
      const t = 90 + 20 * Math.max(0, Math.cos(((h - 15) / 12) * Math.PI));
      hourly.push({ local: at, time: weather.localToUtc(at, off), tempF: t, humidityPct: 20, uvIndex: 9, windMph: 5, isDay: h >= 6 && h < 19, aqi: 40, solarWm2: 700, wetBulbF: t - 25 });
    }
  }
  const daily = [0, 1, 2].map((d) => ({ date: local(Date.now() + d * 86_400_000).slice(0, 10), maxF: 110, feelsMaxF: 110, minF: 90, weatherCode: 0 }));
  const now = hourly.find((h) => h.local.startsWith(today) && h.local.slice(11, 13) === local(Date.now()).slice(11, 13)) ?? hourly[12];
  seedWeather = () => weather.seedForTest({ lat: 33.45, lon: -112.07, fetchedAt: new Date().toISOString(), timezone: 'America/Phoenix', utcOffsetSeconds: off, tempF: now.tempF, humidityPct: 20, uvIndex: 9, windMph: 5, isDay: true, aqi: 40, solarWm2: 700, wetBulbF: now.tempF - 25, hourly, daily });
  seedWeather();
}
let seedWeather = () => {};

function server(farm, scope) {
  if (scope) process.env.SUDOR_SCOPE = scope;
  const s = new McpServer(
    { name: 'sudor', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } },
  );
  return s;
}

async function connect(farm, scope) {
  const { registerTools } = await import('./dist/tools.js');
  const s = server(farm, scope);
  registerTools(s, () => farm);
  delete process.env.SUDOR_SCOPE;
  const client = new Client({ name: 'conversations', version: '0.1.0' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([s.connect(a), client.connect(b)]);
  return client;
}

/** A fresh person for each conversation, set up the way the golden eval's is, with a daughter who agreed to hear. */
async function farmFor(name) {
  const id = `conv:${name.replace(/[^a-z0-9]+/gi, '-')}`;
  const golden = JSON.parse(readFileSync(new URL('./evals/golden.json', import.meta.url), 'utf8'));
  const setup = await connect(id, 'all');
  for (const s of golden.seedCalls ?? []) await setup.callTool({ name: s.tool, arguments: s.args });
  await setup.close();
  seedWeather();
  const store = await import('./dist/store.js');
  const at = new Date().toISOString();
  store.update(id, (p) => void (p.contacts = [{ id: 'c-priya', name: 'Priya', email: 'priya@example.org', relation: 'daughter', notifyOn: ['hot_day', 'emergency'], addedAt: at, confirmedAt: at, acceptedAt: at, stopId: 'stop-priya' }]));
  return connect(id, null);
}

const expected = (turn) => (turn.anyOf ? turn.anyOf : [turn.tool ?? null]);

/** Whether the arguments the file names were chosen. Only the named ones are compared. */
function argsMatch(want, got) {
  return Object.entries(want ?? {}).every(([k, v]) => got?.[k] === v);
}

/** Plays every conversation. `choose` is the stand-in host, or a scripted one in the free test. */
export async function play({ choose, only = null, budget = Infinity, log = console.log }) {
  await seedWorld();
  const results = [];
  let spent = 0;
  const [pin, pout] = PRICES[process.env.SUDOR_AGENT_MODEL] ?? [4, 20];
  for (const conv of FILE.conversations) {
    if (only && !conv.name.includes(only)) continue;
    if (spent >= budget) {
      log(`Stopped at the budget, before "${conv.name}".`);
      break;
    }
    const client = await farmFor(conv.name);
    const tools = (await client.listTools()).tools;
    const history = [];
    const turns = [];
    log(`\n${conv.name}  (${conv.pattern})`);
    for (const turn of conv.turns) {
      const chosen = await choose(turn.say, tools, '', history);
      if (chosen.usage) spent += (chosen.usage.input * pin + (chosen.usage.cacheWrite ?? 0) * pin * 1.25 + (chosen.usage.cacheRead ?? 0) * pin * 0.1 + chosen.usage.output * pout) / 1e6;
      const want = expected(turn);
      const toolOk = want.includes(chosen.tool ?? null);
      const argsOk = !turn.args || !chosen.tool || argsMatch(turn.args, chosen.args);
      let answer = chosen.said ?? '';
      if (chosen.tool) {
        const r = await client.callTool({ name: chosen.tool, arguments: chosen.args ?? {} }).catch((err) => ({ content: [{ text: String(err) }], isError: true }));
        answer = (r.content ?? []).map((c) => c.text ?? '').join(' ').trim();
      }
      history.push({ role: 'user', text: turn.say }, { role: 'assistant', text: answer || '(no answer)' });
      const ok = toolOk && argsOk;
      turns.push({ say: turn.say, want, got: chosen.tool ?? null, args: chosen.args ?? {}, ok, toolOk, argsOk, said: chosen.tool ? '' : (chosen.said ?? '').slice(0, 200) });
      log(`  ${ok ? 'ok  ' : 'MISS'} "${turn.say}"  -> ${chosen.tool ?? 'no tool'}${ok ? '' : `  (wanted ${want.map((w) => w ?? 'no tool').join(' or ')}${toolOk && !argsOk ? `, arguments ${JSON.stringify(chosen.args)}` : ''})`}`);
    }
    await client.close();
    results.push({ name: conv.name, pattern: conv.pattern, turns, allRight: turns.every((t) => t.ok) });
  }
  const all = results.flatMap((r) => r.turns);
  const summary = {
    conversations: results.length,
    conversationsAllRight: results.filter((r) => r.allRight).length,
    turns: all.length,
    turnsRight: all.filter((t) => t.ok).length,
    laterTurns: all.filter((_, i) => i > 0).length,
    costUsd: Math.round(spent * 100) / 100,
  };
  return { summary, results };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/conversations.mjs')) {
  const agent = await import('./dist/agent.js');
  if (!agent.configured()) {
    console.error('SUDOR_ANTHROPIC_KEY (or ANTHROPIC_API_KEY) is not set. node test-conversations.mjs runs the same code for free.');
    process.exit(1);
  }
  const arg = (name, dflt) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : dflt);
  const { summary, results } = await play({ choose: agent.choose, only: arg('--only', null), budget: Number(arg('--budget', 1.5)) });
  console.log(`\n${summary.turnsRight} of ${summary.turns} turns right; ${summary.conversationsAllRight} of ${summary.conversations} conversations right all the way through; about $${summary.costUsd} on ${process.env.SUDOR_AGENT_MODEL}`);
  writeFileSync(new URL('./evals/conversations-last-run.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), model: process.env.SUDOR_AGENT_MODEL, summary, results }, null, 2));
  process.exit(summary.turnsRight === summary.turns ? 0 : 1);
}
