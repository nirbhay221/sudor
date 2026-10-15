/**
 * Writes the skill's tool reference from the server's own tool list, so the two cannot drift.
 *
 *   npm run build && node scripts/skill-tools.mjs          writes skills/sudor-heat-safety/references/tools.md
 *   node scripts/skill-tools.mjs --print                   prints it instead, which is what the test compares
 */
import { writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const OUT = './skills/sudor-heat-safety/references/tools.md';

export async function toolsReference() {
  const { registerTools } = await import('../dist/tools.js');
  const server = new McpServer({ name: 'sudor', version: '0.1.0' });
  registerTools(server, () => 'local-dev');
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'skill-tools', version: '0.1.0' }, { capabilities: {} });
  await client.connect(b);
  const { tools } = await client.listTools();
  await client.close();

  const lines = [
    '# The tools',
    '',
    'Written from the server\'s own tool list by `scripts/skill-tools.mjs`. Do not edit by hand.',
    '',
    'A tool marked "reads" changes nothing. A tool marked "writes" saves or sends something, so the person agrees first.',
    '',
  ];
  for (const t of [...tools].sort((x, y) => x.name.localeCompare(y.name))) {
    lines.push(`## \`${t.name}\``, '', t.annotations?.readOnlyHint ? 'Reads.' : 'Writes.', '', t.description ?? '', '');
    const props = Object.entries(t.inputSchema?.properties ?? {});
    if (!props.length) {
      lines.push('No arguments.', '');
      continue;
    }
    const required = new Set(t.inputSchema?.required ?? []);
    lines.push('| Argument | Values | Needed |', '|---|---|---|');
    for (const [name, schema] of props) {
      const values = schema.enum ? schema.enum.join(', ') : Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type ?? (schema.anyOf ? 'several forms' : 'any');
      lines.push(`| \`${name}\` | ${values} | ${required.has(name) ? 'yes' : 'no'} |`);
    }
    lines.push('');
  }
  return { text: `${lines.join('\n').trimEnd()}\n`, names: tools.map((t) => t.name) };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/skill-tools.mjs')) {
  const { text } = await toolsReference();
  if (process.argv.includes('--print')) process.stdout.write(text);
  else {
    writeFileSync(OUT, text);
    console.log(`wrote ${OUT}`);
  }
  process.exit(0);
}
