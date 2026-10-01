/**
 * Static audit of the published tool list against Anthropic's tool-definition guidance
 * ("provide extremely detailed descriptions", what it does, when to use it AND when not to,
 * what each parameter means) and Alexa+'s certification rule that tool signatures and
 * descriptions are locked after publication, so they have to be right before it.
 *
 * Free, no model. Run: node evals/audit.mjs
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const { registerTools } = await import('../dist/tools.js');
const server = new McpServer({ name: 'audit', version: '1' }, { capabilities: { tools: {}, resources: {} } });
registerTools(server, () => 'audit');
const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);
const tools = (await client.listTools()).tools;

const sentences = (s) => (s.match(/[^.!?]+[.!?]+/g) ?? [s]).length;
const mentionsOther = (d, names) => names.filter((n) => n && d.includes(n));
let flagged = 0;
let hard = 0;
const say = (t, msg) => { flagged++; console.log(`  ${t.name.padEnd(22)} ${msg}`); };

console.log(`${tools.length} tools\n`);
for (const t of tools) {
  const d = t.description ?? '';
  const n = sentences(d);
  const props = Object.entries(t.inputSchema?.properties ?? {});
  const undescribed = props.filter(([, p]) => !p.description && !p.enum).map(([k]) => k);
  const names = tools.filter((o) => o.name !== t.name).map((o) => o.name);
  const refers = mentionsOther(d, names);
  // A description that names a tool which does not exist sends the host to nothing. Found live: log_outing
  // pointed at "heat_warning_signs" after the tool was renamed warning_signs.
  const real = new Set(tools.map((o) => o.name));
  const props2 = new Set(tools.flatMap((o) => Object.keys(o.inputSchema?.properties ?? {})));
  for (const m of d.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []) {
    if (!real.has(m) && !props2.has(m)) { hard++; say(t, `refers to "${m}", which is not a tool`); }
  }
  if (n < 3) say(t, `description is ${n} sentence${n === 1 ? '' : 's'}; guidance asks for at least 3 to 4`);
  if (undescribed.length) say(t, `parameters with no description: ${undescribed.join(', ')}`);
  if (!/(not|instead|only when|rather than|never)/i.test(d) && !refers.length) say(t, 'never says when NOT to use it or what to use instead');
  if (props.some(([k]) => ['name', 'id', 'user', 'type', 'data'].includes(k)) && !props.every(([k, p]) => k !== 'name' || p.description)) {
    say(t, 'a generic parameter name without a description');
  }
}
console.log(`\n${flagged} findings`);
// Only a reference to a tool that does not exist fails the build. The rest are prompts to look, not errors.
process.exit(hard ? 1 : 0);
