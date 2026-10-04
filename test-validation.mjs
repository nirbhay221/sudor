// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * A refused argument is said in words, not in the SDK's (src/plainly.ts).
 *
 * Without this, a call whose arguments fail the schema is answered "MCP error -32602: Input validation
 * error: Invalid arguments for tool register_field: Expected number, received string at lat", which a host
 * can read to the customer. See speakValidationErrors in src/tools.ts. The rewrite reaches into a private
 * field of the SDK, so the first check here is the one that fails the build if an SDK upgrade moves it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'sudor-validation-'));
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
const { speakErrorsPlainly } = await import('./dist/plainly.js');
const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {}, resources: {} } });
registerTools(server, () => 'validation-test');
speakErrorsPlainly(server);
ok('the SDK still keeps its request handlers where the rewrite looks for them',
  server.server._requestHandlers instanceof Map && typeof server.server._requestHandlers.get('tools/call') === 'function');

const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);

const text = (r) => (r.content ?? []).map((c) => c.text ?? '').join(' ');
const BAD = [/MCP error/i, /-32602/, /Input validation/i, /Invalid arguments/i, /\bExpected\b.*\breceived\b/i, /register_field|register_location/];

console.log('\nA wrong-typed argument');
const wrong = await client.callTool({ name: 'register_location', arguments: { place: 'x', lat: 'north', lon: 1 } });
ok('is still an error to the host', wrong.isError === true);
ok('says which detail it could not use, in words', /didn't get one of the details/.test(text(wrong)), text(wrong));
ok('asks for it again', /Tell me again/.test(text(wrong)));
ok('quotes nothing from the protocol or the validation library', BAD.every((re) => !re.test(text(wrong))), text(wrong));

console.log('\nAn out-of-range argument');
const range = await client.callTool({ name: 'register_location', arguments: { place: 'x', lat: 95, lon: 1 } });
ok('is rewritten the same way', range.isError && /didn't get one of the details/.test(text(range)) && BAD.every((re) => !re.test(text(range))), text(range));

console.log('\nEverything else is left alone');
const good = await client.callTool({ name: 'register_location', arguments: { place: 'Phoenix, Arizona', lat: 33.45, lon: -112.07 } });
ok('a valid call is not an error', !good.isError, text(good));
const missing = await client.callTool({ name: 'what_can_you_do', arguments: { nonsense: 1 } });
ok('an unknown extra argument is still ignored', !missing.isError && text(missing).length > 20);

const unknown = await client.callTool({ name: 'no_such_tool', arguments: {} });
ok('a tool that does not exist is still an error to the host', unknown.isError === true);
ok('and is answered in words, without the protocol or the tool name', /Ask me what I can do/i.test(text(unknown)) && !/-32602|MCP error|no_such_tool/.test(text(unknown)), text(unknown));

await client.close();
await server.close();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
