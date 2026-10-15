#!/usr/bin/env node
/**
 * Checks that a Sudor MCP server is reachable and lists its tools. It reads only: no tool is called, nothing is
 * saved and nobody is emailed. Needs Node 18 or later and nothing else.
 *
 *   node scripts/connect.mjs                      the server on this machine, http://127.0.0.1:8789/mcp
 *   node scripts/connect.mjs https://host/mcp     another one
 *   SUDOR_URL=https://host/mcp node scripts/connect.mjs
 *   node scripts/connect.mjs https://host/mcp --demo     as a visitor to the public demo, with a throwaway id
 *
 * Exits 0 when the server answered with its tools, 1 when it did not.
 */
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
// The public demo lets anyone in under an id of their own making, which is what the demo page does.
const demo = args.includes('--demo') ? randomBytes(16).toString('hex') : null;
const url = args.find((a) => !a.startsWith('--')) ?? process.env.SUDOR_URL ?? 'http://127.0.0.1:8789/mcp';
const PROTOCOL = '2025-11-25';

let session;
async function rpc(method, params, id) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(demo ? { 'x-sudor-demo': demo } : {}),
      ...(session ? { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': PROTOCOL } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) }),
    signal: AbortSignal.timeout(15_000),
  });
  session = res.headers.get('mcp-session-id') ?? session;
  if (id === undefined) return null;
  if (res.status === 401) throw new Error('the server wants a signed-in account: connect it through your assistant, which handles the sign-in, or add --demo for the public demo');
  if (!res.ok) throw new Error(`the server answered ${res.status}`);
  const body = await res.text();
  const line = body.split('\n').find((l) => l.startsWith('data: '));
  const reply = JSON.parse(line ? line.slice(6) : body);
  if (reply.error) throw new Error(reply.error.message ?? 'the server returned an error');
  return reply.result;
}

try {
  const hello = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'sudor-skill-check', version: '0.1.0' } }, 1);
  await rpc('notifications/initialized');
  const { tools } = await rpc('tools/list', {}, 2);
  console.log(`Connected to ${hello.serverInfo?.title ?? hello.serverInfo?.name} at ${url}`);
  console.log(`Protocol ${hello.protocolVersion}, ${tools.length} tools:`);
  for (const t of tools) console.log(`  ${t.name}${t.annotations?.readOnlyHint ? '' : '  (writes)'}`);
  if (hello.instructions) console.log(`\nWhat it knows about this person: ${hello.instructions.split('. ').slice(-2).join('. ')}`);
} catch (err) {
  console.error(`Could not reach Sudor at ${url}: ${err.message}`);
  process.exit(1);
}
