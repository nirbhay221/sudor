/**
 * What the README says, checked against what the code does.
 *
 * A judge reads the README before anything else, and a number in it that the code no longer backs is worse than no
 * number. Every count and claim below is read from the README and compared with the thing it describes: the tools a
 * host is shown, the cooling-centre lists, the conditions and medicines, the model the demo uses, the check counts,
 * the conversation results on record, and every file the README points at. Phrases that were true once and are not
 * now are listed and must not come back.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';

delete process.env.SUDOR_SCOPE;
process.env.SUDOR_DATA = './data/test-readme/people.json';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const readme = readFileSync('./README.md', 'utf8');
const WORDS = { thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, 'twenty-three': 23, 'seventy-one': 71, 'seventy-two': 72, 'fifty-seven': 57 };
const number = (w) => (/^\d/.test(w) ? Number(w.replace(/,/g, '')) : WORDS[w.toLowerCase()]);

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { registerTools } = await import('./dist/tools.js');
const server = new McpServer({ name: 'sudor', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } });
registerTools(server, () => 'readme');
const client = new Client({ name: 'readme', version: '0.1.0' }, { capabilities: {} });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);
const tools = (await client.listTools()).tools.map((t) => t.name);

console.log('\nCounts');
const toolClaims = [...readme.matchAll(/(\d+) tools by default/g)].map((m) => Number(m[1]));
check('"N tools by default" is the number a host is shown', toolClaims.length > 0 && toolClaims.every((n) => n === tools.length), `${toolClaims} vs ${tools.length}`);
const cooling = await import('./dist/cooling.js');
const lists = /([a-z-]+|\d+) open lists published by/i.exec(readme)?.[1];
check('the number of cooling-centre lists is the number read', number(lists ?? '') === cooling.sourceNames().length, `${lists} vs ${cooling.sourceNames().length}`);
const { CONDITIONS } = await import('./dist/conditions.js');
const conditions = /\* ([A-Z][a-z-]+) conditions, and medicines/.exec(readme)?.[1];
check('the number of conditions is the number known', number(conditions ?? '') === CONDITIONS.length, `${conditions} vs ${CONDITIONS.length}`);
check('the opening says the same number of conditions', new RegExp(`some antidepressants and ${conditions?.toLowerCase()} conditions`).test(readme));
const { MEDICATIONS } = await import('./dist/meds.js');
const table = /([A-Z][a-z-]+) are in Sudor's own table/.exec(readme)?.[1];
check('the medicine table is the size the README gives', number(table ?? '') === MEDICATIONS.length, `${table} vs ${MEDICATIONS.length}`);

console.log('\nCheck counts');
const total = [...readme.matchAll(/([\d,]+) (?:automated )?checks/g)].map((m) => number(m[1]));
const unit = number(/npm run test:unit\s+# ([\d,]+) checks/.exec(readme)?.[1] ?? '0');
const live = number(/npm run test:live\s+# ([\d,]+) checks/.exec(readme)?.[1] ?? '0');
const npmTest = number(/`npm test` runs (?:everything, )?([\d,]+) checks/.exec(readme)?.[1] ?? '0');
check('npm test is the unit checks plus the live ones', npmTest === unit + live && unit > 0 && live > 0, `${npmTest} vs ${unit} + ${live}`);
check('every check count stated is the total, the unit count or the live count', total.filter((n) => n > 1000).every((n) => n === npmTest || n === unit), JSON.stringify(total));

console.log('\nThe demo model and the conversation results');
const agentSrc = readFileSync('./src/agent.ts', 'utf8');
const demoModel = /The talking demo \| \*\*Real model\*\*: Claude ([A-Za-z]+ [\d.]+)/.exec(readme)?.[1];
const id = /AGENT_MODEL \?\? 'claude-([a-z]+)-(\d)-(\d)/.exec(agentSrc);
check('the demo model named is the stand-in\'s default', demoModel && id && demoModel.toLowerCase() === `${id[1]} ${id[2]}.${id[3]}`, `${demoModel} vs ${id?.slice(1).join('-')}`);
const run = JSON.parse(readFileSync('./evals/conversations-last-run.json', 'utf8'));
const said = /got (\d+) of\s+(\d+) turns right on (\w+)/.exec(readme.replace(/\n/g, ' '));
check('the conversation result quoted is the one on record', said && Number(said[1]) === run.summary.turnsRight && Number(said[2]) === run.summary.turns && run.model.includes(said[3].toLowerCase()), `${said?.slice(1)} vs ${JSON.stringify(run.summary)} ${run.model}`);

console.log('\nNames and files');
const named = [...new Set([...readme.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]))];
process.env.SUDOR_SCOPE = 'all';
const all = new McpServer({ name: 'sudor', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } });
registerTools(all, () => 'readme-all');
delete process.env.SUDOR_SCOPE;
const c2 = new Client({ name: 'readme', version: '0.1.0' }, { capabilities: {} });
const [a2, b2] = InMemoryTransport.createLinkedPair();
await Promise.all([all.connect(a2), c2.connect(b2)]);
const every = new Set([...(await c2.listTools()).tools.map((t) => t.name), ...tools]);
// Orbita's own tool, named where Sudor asks Orbita about storms.
const ORBITA_TOOLS = ['storm_status'];
const looksLikeTool = (n) => /^(weather|plan|going|warning|somewhere|storm|get|log|share|check|about|tell|what|medicine|my|set|register|should|sun|contact)_/.test(n);
const notTools = named.filter((n) => looksLikeTool(n) && !every.has(n) && !ORBITA_TOOLS.includes(n));
check('every tool name in backticks is a real tool', notTools.length === 0, notTools.join());
const paths = [...new Set([...readme.matchAll(/`((?:src|evals|skills|scripts|strands|deploy|web|ui)\/[A-Za-z0-9_./-]+\.(?:ts|mjs|json|md|html|txt|sh))`/g)].map((m) => m[1]))];
// A path in the Agent Skill's table is inside the skill's own folder.
const found = (p) => existsSync(p) || readdirSync('./skills').some((d) => existsSync(`./skills/${d}/${p}`));
check('every file the README points at exists', paths.length > 10 && paths.every(found), paths.filter((p) => !found(p)).join());
const env = [...new Set([...readme.matchAll(/\bSUDOR_[A-Z_]+/g)].map((m) => m[0]))];
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(`${d}/${e.name}`)) : /\.(ts|sh|mjs|service|conf)$/.test(e.name) ? [`${d}/${e.name}`] : []));
const sources = [...walk('./src'), ...walk('./deploy'), ...walk('./strands')].map((f) => readFileSync(f, 'utf8')).join('\n');
check('every setting the README names is read by the code', env.every((v) => sources.includes(v)), env.filter((v) => !sources.includes(v)).join());

console.log('\nThings that were true once');
for (const stale of ['Plus 57 medications', 'fifteen conditions change', 'Claude Haiku 4.5 reads', 'seven open lists', 'sixteen open lists', 'Twelve conditions', 'a dozen conditions', 'California only', 'fifty-seven are named one by one']) {
  check(`"${stale}" is not said any more`, !readme.includes(stale));
}
check('no em dashes or arrows', !/[—–→]/.test(readme));

await client.close();
await c2.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
