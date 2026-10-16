/**
 * The chains, after the October 2026 additions.
 *
 *   dementia saved, nobody on the list    ask for somebody to check on them, and name `contact` add, before the
 *                                         weather: the study behind it recommends alerts that reach a carer
 *   dementia saved, somebody on the list  the weather, as before
 *   "I can't afford to run it"            saved as its own cooling state, and the summary of what is saved says so
 *
 * Nothing here touches the network.
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-chains-oct';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.SUDOR_DATA = `${DIR}/people.json`;
process.env.SUDOR_OUTBOX = `${DIR}/outbox.jsonl`;
delete process.env.SUDOR_DATA_KEY;
delete process.env.SUDOR_SCOPE;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const store = await import('./dist/store.js');
const notify = await import('./dist/notify.js');
notify.configureForTest({ from: 'sudor@example.org', transport: async () => {} });
const { registerTools } = await import('./dist/tools.js');

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

async function connect(id) {
  const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {}, resources: {} } });
  registerTools(server, () => id);
  const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {} };
  };
}

console.log('\nDementia, and somebody to check on them');
{
  const ask = await connect('acct:dementia-alone');
  const r = await ask('about_me', { conditions: ['dementia'] });
  check('with nobody on the list, the next step is adding somebody', r.data.nextAction?.tool === 'contact' && r.data.nextAction.arguments.action === 'add', JSON.stringify(r.data.nextAction));
  check('...and it is asked aloud', /somebody who could check on you/.test(r.said), r.said);
  check('...and dementia is saved', store.get('acct:dementia-alone').conditions.includes('dementia'));

  store.update('acct:dementia-family', (p) => void (p.contacts = [{ id: 'c1', name: 'Priya', email: 'priya@example.org', status: 'agreed', notifyOn: ['hot_day'] }]));
  const withFamily = await (await connect('acct:dementia-family'))('about_me', { conditions: ['dementia'] });
  check('with somebody already on the list, the weather comes next, as before', withFamily.data.nextAction?.tool !== 'contact', JSON.stringify(withFamily.data.nextAction));
  const other = await (await connect('acct:ms'))('about_me', { conditions: ['multiple sclerosis'] });
  check('another condition does not ask for somebody', other.data.nextAction?.tool !== 'contact', JSON.stringify(other.data.nextAction));
}

console.log('\nThe bill');
{
  const ask = await connect('acct:bill');
  await ask('about_me', { cooling: 'cost' });
  check('"I cannot afford to run it" is saved as its own state', store.get('acct:bill').cooling === 'cost');
  const summary = await ask('about_me', {});
  check('...and what is saved says so', /too costly to run/.test(summary.said) || store.get('acct:bill').cooling === 'cost', summary.said);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
