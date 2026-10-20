/**
 * The Strands agent, run for nothing: no key, no language model, no network.
 *
 * The real Sudor tools are registered on an in-process MCP server with a dangerous day seeded, and the agent is
 * connected to it through Strands' own MCP client. The model is the scripted one in agent.mjs, which follows
 * each `nextAction`, so what is checked here is everything except Claude's choice of words: the connection, the
 * skill read from the server, the wrapped tools, the chain, the yes before anything is saved or sent, and the
 * cap on steps.
 *
 * Run it from the repository root after `npm run build`:  node strands/test.mjs
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-strands';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.SUDOR_DATA = `${DIR}/people.json`;
process.env.SUDOR_OUTBOX = `${DIR}/outbox.jsonl`;
delete process.env.SUDOR_DATA_KEY;
delete process.env.ANTHROPIC_API_KEY;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ChainModel, SKILL_URI, claude, connect, run, systemPrompt, wrap } from './agent.mjs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

// No network: the forecast download is refused so the seeded day stands, and nothing else is fetched.
globalThis.fetch = async () => { throw new Error('offline in this test'); };

const weather = await import('../dist/weather.js');
const shelters = await import('../dist/shelters.js');
const { registerTools } = await import('../dist/tools.js');
const { registerSkills } = await import('../dist/skill.js');

/** A day whose heat index peaks at `high`, with local time at midday wherever the clock is. */
function seedDay(lat, lon, high) {
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
      const t = high - Math.abs(h - 15) * 1.5;
      hourly.push({ local: at, time: weather.localToUtc(at, off), tempF: t, humidityPct: 20, uvIndex: 5, windMph: 5, isDay: h >= 6 && h < 19, aqi: 40, solarWm2: 500, wetBulbF: t - 25 });
    }
  }
  const daily = [0, 1, 2].map((d) => ({ date: local(Date.now() + d * 86_400_000).slice(0, 10), maxF: high, feelsMaxF: high, minF: high - 20, weatherCode: 0 }));
  const now = hourly.find((h) => h.local.startsWith(today) && h.local.slice(11, 13) === local(Date.now()).slice(11, 13)) ?? hourly[12];
  weather.seedForTest({ lat, lon, fetchedAt: new Date().toISOString(), timezone: 'America/Phoenix', utcOffsetSeconds: off, tempF: now.tempF, humidityPct: 20, uvIndex: 5, windMph: 5, isDay: true, aqi: 40, solarWm2: 500, wetBulbF: now.tempF - 25, hourly, daily });
}

/** The person's own account, set up through every tool, the way a first conversation would. */
async function person(id, setup, scope = 'all') {
  if (scope) process.env.SUDOR_SCOPE = scope;
  const server = new McpServer({ name: 'sudor', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } });
  registerTools(server, () => id);
  delete process.env.SUDOR_SCOPE;
  const client = new Client({ name: 'setup', version: '1' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  for (const [name, args] of setup) await client.callTool({ name, arguments: args });
  await client.close();
}

/** Sudor as a host sees it, default tools and the skill, with the agent's end of the connection. */
async function sudorFor(id) {
  const server = new McpServer({ name: 'sudor', title: 'Sudor', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} }, instructions: 'This customer has already saved a place.' });
  registerTools(server, () => id);
  registerSkills(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  return connect({ transport: b });
}

shelters.seedForTest([]);
seedDay(33.45, -112.07, 110);
await person('acct:strands', [
  ['register_location', { place: 'Phoenix, Arizona', lat: 33.45, lon: -112.07 }],
  ['medication', { action: 'add', name: 'metoprolol' }],
]);
// The cooling at home works, so the question on a dangerous day is when to go out, not where to go.
await person('acct:strands', [['about_me', { cooling: 'working' }]], null);
seedDay(33.45, -112.07, 110);

console.log('\nConnected through Strands\' MCP client');
const sudor = await sudorFor('acct:strands');
check('the tools are the server\'s default set', sudor.tools.length === 17 && sudor.tools.some((t) => t.name === 'weather_check'), String(sudor.tools.length));
check('the skill was read from the server, not from a file', /^---\nname: sudor-heat-safety\n/.test(sudor.skill) && SKILL_URI === 'skill://sudor-heat-safety/SKILL.md');
check('the server\'s instructions came with it', /already saved a place/.test(sudor.instructions));
const prompt = systemPrompt(sudor);
check('the system prompt is the skill, without its frontmatter', /## Choosing the tool/.test(prompt) && /## Following the chain/.test(prompt) && !/^name: sudor-heat-safety$/m.test(prompt));
check('...followed by what the server knows about this person', prompt.indexOf('already saved a place') > prompt.indexOf('## Following the chain'));
check('...and it tells the model how the wrapped results read', /`say`/.test(prompt) && /`nextAction`/.test(prompt) && /`refused`/.test(prompt));

console.log('\nOne request, carried down the chain');
const out = await run('Is it safe for me to go out?', { sudor, model: new ChainModel({ from: 'weather_check' }) });
if (process.env.SHOW) console.log(JSON.stringify(out.trace, null, 1));
const ran = out.trace.filter((t) => !t.refused);
check('it began where it was told', out.trace[0]?.tool === 'weather_check', JSON.stringify(out.trace.map((t) => t.tool)));
check('the first answer names the medicine and why', /metoprolol/i.test(ran[0]?.say ?? ''), ran[0]?.say);
check('more than one step was taken from the one request', ran.length >= 2, JSON.stringify(out.trace.map((t) => t.tool)));
check('every step after the first is the one the answer before it named', out.trace.slice(1).every((t, i) => out.trace[i].nextAction?.tool === t.tool), JSON.stringify(out.trace.map((t) => [t.tool, t.nextAction?.tool])));
check('...with the arguments it was given, not rebuilt', out.trace.slice(1).every((t, i) => JSON.stringify(t.args) === JSON.stringify(out.trace[i].nextAction.arguments)));
check('each wrapped result carried the chain it is on', ran.slice(1).every((t) => t.flow && t.flow.done.includes(t.tool)), JSON.stringify(ran.map((t) => t.flow)));
check('it stopped when an answer named nothing, or a step needed a yes', out.stopReason === 'endTurn' && (!ran.at(-1).nextAction || out.trace.at(-1).refused === 'needs_yes'), JSON.stringify(out.trace.at(-1)));
check('what is said to the person is the answers, in order', ran.every((t) => out.said.includes(t.say)) && out.said.indexOf(ran[0].say) === 0, out.said.slice(0, 160));
check('no tokens were used', (out.usage?.totalTokens ?? 0) === 0, JSON.stringify(out.usage));

console.log('\nNothing is saved or sent without a yes');
{
  const trace = [];
  const tools = wrap(sudor, { trace });
  const help = tools.find((t) => t.name === 'get_help');
  const refused = await help.invoke({ what: 'I feel faint' });
  check('get_help is refused, and says why', refused.refused === 'needs_yes' && /has not said yes/.test(refused.say), JSON.stringify(refused));
  check('...and the server was never called', trace.length === 1 && trace[0].refused === 'needs_yes' && !trace[0].flow);
  const read = await tools.find((t) => t.name === 'weather_check').invoke({});
  check('a tool that only reads runs without asking', !read.refused && /metoprolol/i.test(read.say));
  const told = [];
  const allowed = wrap(sudor, { yes: true, trace: told });
  const logged = await allowed.find((t) => t.name === 'log_outing').invoke({ felt: 'fine', minutes: 20 });
  check('with a yes, a tool that saves does run', !logged.refused && told.length === 1 && typeof logged.say === 'string' && logged.say.length > 0, JSON.stringify(logged));
  const writers = sudor.tools.filter((t) => t.toolSpec.annotations?.readOnlyHint !== true).map((t) => t.name).sort();
  check('the tools held back are exactly the ones the server marks as writing', writers.join() === ['about_me', 'contact', 'doctor_plan', 'get_help', 'log_outing', 'my_trips', 'share_my_day', 'warning_signs'].join(), writers.join());
}

console.log('\nA chain that reaches a step needing a yes stops there and asks');
{
  const stopped = await run('I just got back and felt unwell', { sudor, model: new ChainModel({ from: 'log_outing', args: { felt: 'unwell' } }) });
  check('the first step, a write, was not run', stopped.trace.length === 1 && stopped.trace[0].refused === 'needs_yes', JSON.stringify(stopped.trace));
  check('...and the person is told a yes is needed', /has not said yes/.test(stopped.said), stopped.said);
  const went = await run('I just got back and felt unwell', { sudor, yes: true, model: new ChainModel({ from: 'log_outing', args: { felt: 'unwell' } }) });
  check('with a yes it runs, and goes on to the warning signs', went.trace.map((t) => t.tool).join() === 'log_outing,warning_signs', JSON.stringify(went.trace.map((t) => t.tool)));
}

console.log('\nA run has a ceiling');
{
  const capped = await run('Is it safe for me to go out?', { sudor, steps: 1, model: new ChainModel({ from: 'weather_check' }) });
  const done = capped.trace.filter((t) => !t.refused);
  check('with one step allowed, one tool is called', done.length === 1, JSON.stringify(capped.trace.map((t) => [t.tool, t.refused])));
  check('...and the next is turned away as over the limit, not run', capped.trace.length === 1 || capped.trace[1].refused === 'limit', JSON.stringify(capped.trace[1]));
}

console.log('\nClaude is only reached when asked for');
{
  let message = '';
  try { await claude({ apiKey: '' }); } catch (err) { message = err.message; }
  check('without a key it refuses, and points at the free mode', /ANTHROPIC_API_KEY is not set/.test(message) && /--plan/.test(message), message);
  const model = await claude({ apiKey: 'not-a-real-key' });
  const config = model.getConfig();
  check('with one, it is Strands\' Anthropic provider on the cheapest current Claude', model.constructor.name === 'AnthropicModel' && config.modelId === 'claude-haiku-5-5', JSON.stringify(config));
  check('...with the reply capped, and no request made to build it', config.maxTokens === 700);
}

await sudor.mcp.disconnect();
rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
