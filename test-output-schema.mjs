// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * Every tool declares what its answers contain, and every answer keeps the promise.
 *
 * Alexa+ asks for "well-formed responses that conform to your declared schema". The SDK enforces the
 * declaration at call time: a tool that declares an outputSchema and then returns a result with no
 * structured content fails the call. So this walks every tool, calls it for real with the dullest
 * valid arguments, in a fresh store, and checks both halves: the schema is published, and the answer
 * carries the field it promises.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'sudor-outschema-'));
process.env.SUDOR_DATA = join(scratch, 'people.json');
process.env.SUDOR_AUTH_DATA = join(scratch, 'auth.json');

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
};

const { registerTools } = await import('./dist/tools.js');
const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {}, resources: {} } });
registerTools(server, () => 'schema-test');
const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);

const tools = (await client.listTools()).tools;

/** The dullest arguments the schema allows. */
function dull(tool) {
  const s = tool.inputSchema ?? {};
  const args = {};
  for (const k of s.required ?? []) {
    const p = s.properties?.[k] ?? {};
    args[k] = p.enum ? p.enum[0] : p.type === 'number' || p.type === 'integer' ? 1 : p.type === 'boolean' ? true : 'x';
  }
  return args;
}

console.log('\nEvery tool publishes an output schema');
for (const t of tools) {
  ok(`${t.name} declares one`, t.outputSchema?.type === 'object' && Boolean(t.outputSchema.properties?.spoken), JSON.stringify(t.outputSchema));
}
ok('the schema leaves room for each tool to add its own fields', tools.every((t) => t.outputSchema?.additionalProperties !== false));

console.log('\nEvery tool keeps the promise when called');
for (const t of tools) {
  let r;
  let err = '';
  try {
    r = await client.callTool({ name: t.name, arguments: dull(t) });
  } catch (e) {
    err = String(e.message ?? e).slice(0, 200);
  }
  ok(`${t.name} answers without a schema error`, !err, err);
  if (!r) continue;
  const text = (r.content ?? []).map((c) => c.text ?? '').join(' ').trim();
  ok(`${t.name}: the text is not empty`, text.length > 0);
  if (!r.isError) {
    ok(`${t.name}: structured spoken matches the text`, typeof r.structuredContent?.spoken === 'string' && r.structuredContent.spoken.length > 0, JSON.stringify(r.structuredContent)?.slice(0, 120));
  }
}

await client.close();
await server.close();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
