/**
 * The Agent Skill in skills/sudor-heat-safety, checked against the format and against the server it describes.
 *
 *   The format: agentskills.io/specification. A name that matches its folder, a description inside the limit,
 *   a body short enough to load whole, and links that go one level down to files that exist.
 *
 *   The server: every tool the skill names is a real tool, every tool the server offers is in the skill, the
 *   tool reference is the server's own list, and each chain the skill describes is one the code really names.
 *
 *   The delivery: the same files are readable as MCP resources, byte for byte, and the script inside the skill
 *   connects to a running server and lists its tools.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';

// The default set of tools, which is what a host is shown and what the skill is written for.
delete process.env.SUDOR_SCOPE;
const DATA = './data/test-skill.json';
rmSync(DATA, { force: true });
process.env.SUDOR_DATA = DATA;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const NAME = 'sudor-heat-safety';
const DIR = `./skills/${NAME}`;
const read = (p) => readFileSync(`${DIR}/${p}`, 'utf8').replace(/\r\n/g, '\n');
const skill = read('SKILL.md');
const chains = read('references/chains.md');

console.log('\nThe format');
const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
const body = skill.slice(skill.indexOf('\n---\n', 4) + 5);
const field = (key) => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(front)?.[1].trim() ?? '';
check('SKILL.md opens with frontmatter', front.length > 0);
check('the name is the folder name', field('name') === NAME, field('name'));
check('...lower case letters, digits and single hyphens, 64 at most', /^[a-z0-9]+(-[a-z0-9]+)*$/.test(field('name')) && field('name').length <= 64);
const description = field('description');
check('the description is inside 1024 characters', description.length > 0 && description.length <= 1024, String(description.length));
check('...and says both what it does and when to use it', /\bUse when\b/.test(description) && /medicines/.test(description));
check('compatibility is inside 500 characters', field('compatibility').length > 0 && field('compatibility').length <= 500);
check('the licence is the repository licence', field('license') === 'Apache-2.0' && /Apache License/.test(readFileSync('./LICENSE', 'utf8')));
check('SKILL.md is under 500 lines', skill.split('\n').length < 500, String(skill.split('\n').length));
// About four characters to a token: the spec asks for instructions under 5000 tokens.
check('...and under 5000 tokens, near enough', body.length / 4 < 5000, String(Math.round(body.length / 4)));
const links = [...body.matchAll(/\]\(([^)#]+)\)/g)].map((m) => m[1]).filter((l) => !/^https?:/.test(l));
check('it links to its reference files', links.length >= 2, links.join());
check('every link is to a file that exists', links.every((l) => existsSync(`${DIR}/${l}`)), links.filter((l) => !existsSync(`${DIR}/${l}`)).join());
check('...one level down and no further', links.every((l) => l.split('/').length <= 2), links.join());
check('no em dashes or arrows in what an assistant will read', ![skill, chains].some((t) => /[—–→]|->/.test(t)));

console.log('\nAgainst the server');
const { registerTools } = await import('./dist/tools.js');
const { registerSkills, skillFiles } = await import('./dist/skill.js');
const server = new McpServer({ name: 'sudor', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } });
registerTools(server, () => 'acct:skill');
registerSkills(server);
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: 'test-skill', version: '0.1.0' }, { capabilities: {} });
await client.connect(b);
const tools = (await client.listTools()).tools.map((t) => t.name);

// Anything in backticks shaped like a tool name, which is every snake_case word.
const named = (text) => [...new Set([...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]))];
check('every tool the skill names is a real one', named(skill).every((n) => tools.includes(n)), named(skill).filter((n) => !tools.includes(n)).join());
check('...and so is every tool in the chains', named(chains).every((n) => tools.includes(n)), named(chains).filter((n) => !tools.includes(n)).join());
const choosing = skill.slice(skill.indexOf('## Choosing the tool'), skill.indexOf('## Following the chain'));
check('every tool the server offers is in the table for choosing one', tools.every((t) => choosing.includes(`\`${t}\``)), tools.filter((t) => !choosing.includes(`\`${t}\``)).join());

const { toolsReference } = await import('./scripts/skill-tools.mjs');
const reference = await toolsReference();
check('the tool reference is the server\'s own list, not a copy that has drifted', reference.text === read('references/tools.md'), 'run: node scripts/skill-tools.mjs');
check('...with every tool in it', tools.every((t) => reference.text.includes(`## \`${t}\``)));

console.log('\nThe chains it describes are the ones the code names');
const { nextFor } = await import('./dist/finish.js');
const flow = await import('./dist/flow.js');
const rows = [...chains.matchAll(/^\| `([a-z_]+)` \| ([^|]+) \| `([a-z_]+)`/gm)].map((m) => ({ after: m[1], when: m[2].trim(), next: m[3] }));
check('the chain tables parse', rows.length >= 12, String(rows.length));
check('every step in them is a tool', rows.every((r) => tools.includes(r.after) && tools.includes(r.next)), JSON.stringify(rows.filter((r) => !tools.includes(r.after) || !tools.includes(r.next))));
const has = (after, next) => rows.some((r) => r.after === after && r.next === next);
check('a warning named by the weather answer leads to what to do about it', has('weather_check', 'storm_prep') && nextFor('weather_check', {}, { warning: 'Heat Advisory' })?.tool === 'storm_prep');
check('a day with no safe hour leads to going out anyway', has('plan_my_day', 'going_out_now') && nextFor('plan_my_day', {}, { best: { status: 'avoid' } })?.tool === 'going_out_now');
check('precautions held back lead to the rest of them, with the step', has('going_out_now', 'going_out_now') && nextFor('going_out_now', {}, { nextStep: 3 })?.arguments.step === 3);
check('feeling unwell after an outing leads to the warning signs', has('log_outing', 'warning_signs') && nextFor('log_outing', { felt: 'unwell' }, {})?.tool === 'warning_signs');
check('the warning signs point nowhere, as the skill says', !rows.some((r) => r.after === 'warning_signs') && nextFor('warning_signs', {}, {}) === null && /names no next step/.test(chains));
check('a fine day points nowhere', nextFor('weather_check', {}, {}) === null && nextFor('plan_my_day', {}, { best: { status: 'ok' } }) === null);
// The steps the tools name themselves, read from the source so a renamed step is caught.
const source = (p) => readFileSync(p, 'utf8');
check('the weather answer names the day plan and somewhere to go itself', has('weather_check', 'plan_my_day') && has('weather_check', 'somewhere_to_go') && /nextAction: \{ tool: 'somewhere_to_go'/.test(source('./src/tools/conditions_raw.ts')) && /nextAction: \{ tool: 'plan_my_day'/.test(source('./src/tools/conditions_raw.ts')));
check('the day plan names somewhere to go for a home with no cooling', has('plan_my_day', 'somewhere_to_go') && /noCooling \? \{ nextAction: \{ tool: 'somewhere_to_go'/.test(source('./src/tools/plan.ts')));
check('storm advice names somewhere to go, or telling the family', has('storm_prep', 'somewhere_to_go') && has('storm_prep', 'get_help') && /tool: 'get_help', arguments: \{ status: 'safe' \}/.test(source('./src/tools/official.ts')));
check('somewhere to go names getting help, and getting help names somewhere to go', has('somewhere_to_go', 'get_help') && has('get_help', 'somewhere_to_go') && /tool: 'get_help'/.test(source('./src/tools/refuge.ts')));
check('a new contact names the confirmation', has('contact', 'contact') && /action: 'confirm'/.test(source('./src/tools/contact.ts')));

flow.resetForTest();
flow.describe('acct:skill-flow', 'weather_check', { tool: 'plan_my_day', arguments: {} });
const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(chains)[1]);
const real = flow.describe('acct:skill-flow', 'plan_my_day', { tool: 'going_out_now', arguments: {} });
check('the example of `flow` in the skill is what the server really returns', JSON.stringify(example) === JSON.stringify(real), JSON.stringify(real));
flow.resetForTest();

console.log('\nRead from the server, over MCP');
const files = skillFiles();
const { resources } = await client.listResources();
const listed = resources.filter((r) => r.uri.startsWith('skill://'));
check('every file of the skill is listed as a resource', listed.length === files.length && files.length >= 4, `${listed.length} of ${files.length}`);
const main = listed.find((r) => r.uri === `skill://${NAME}/SKILL.md`);
check('SKILL.md is listed with the skill\'s own description, so a host can decide before reading it', main?.description === description && main?.mimeType === 'text/markdown', JSON.stringify(main));
const got = await client.readResource({ uri: `skill://${NAME}/SKILL.md` });
check('reading it returns the file, byte for byte', got.contents[0].text === skill);
const sha = createHash('sha256').update(skill).digest('hex');
check('...with a digest a host can check it against', main?._meta?.['io.modelcontextprotocol/skills']?.sha256 === sha);
for (const f of files.filter((x) => x.path !== 'SKILL.md')) {
  const r = await client.readResource({ uri: f.uri });
  check(`${f.path} reads back the same`, r.contents[0].text === read(f.path));
}
check('the running server registers the skill', /registerSkills\(server\)/.test(source('./src/server.ts')));
check('...and the deploy bundle and the container both carry the folder', /\bui assets skills\b/.test(source('./deploy/bundle.sh')) && /COPY skills \.\/skills/.test(source('./Dockerfile')));
await client.close();

console.log('\nThe script inside the skill, against a running server');
const PORT = 8791;
const child = spawn(process.execPath, ['dist/server.js'], { env: { ...process.env, PORT: String(PORT), SUDOR_DATA: DATA, SUDOR_AUTH: 'off' }, stdio: 'ignore' });
const stop = () => { try { child.kill(); } catch { /* already gone */ } };
process.on('exit', stop);
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); }
}
check('the server came up', up);
const ran = spawnSync(process.execPath, [`${DIR}/scripts/connect.mjs`, `http://127.0.0.1:${PORT}/mcp`], { encoding: 'utf8' });
check('connect.mjs connects and exits clean', ran.status === 0, ran.stderr);
check('...on the protocol version the track asks for', /Protocol 2025-11-25/.test(ran.stdout), ran.stdout.slice(0, 200));
check('...and lists every tool', tools.every((t) => new RegExp(`^  ${t}\\b`, 'm').test(ran.stdout)), ran.stdout);
check('...marking the ones that write', /^  get_help {2}\(writes\)$/m.test(ran.stdout) && /^  weather_check$/m.test(ran.stdout));
const none = spawnSync(process.execPath, [`${DIR}/scripts/connect.mjs`, 'http://127.0.0.1:9/mcp'], { encoding: 'utf8' });
check('with no server there it says so and exits 1', none.status === 1 && /Could not reach Sudor/.test(none.stderr), none.stderr);
stop();
rmSync(DATA, { force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
