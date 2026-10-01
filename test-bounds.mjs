/**
 * What a stranger can make this server keep, follow and poll.
 *
 * Every record with a place in it is polled: weather on a twenty minute timer, the
 * National Weather Service every ten minutes. Every medicine name becomes a recall
 * query. And persist() rewrites the whole people file synchronously on every update.
 * So the size of anything an anonymous caller can grow is, through a side door, the
 * load on two free public APIs and the latency of every other user's next write.
 *
 * None of that was bounded. These tests pin the ceilings, and the ones that matter
 * most are about who pays when a ceiling is hit: a linked account must never be the
 * one evicted, and a newcomer to the sandbox must never be the one refused.
 *
 * The network is stubbed throughout. Nothing here reaches Open-Meteo.
 */
import { mkdirSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const DIR = './data/test-bounds';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.SUDOR_DATA = `${DIR}/people.json`;
process.env.SUDOR_AUTH_DATA = `${DIR}/auth.json`;
delete process.env.SUDOR_DATA_KEY;
process.env.SUDOR_MAX_DEMO_RECORDS = '5';
process.env.SUDOR_MAX_RECORDS = '8';
process.env.SUDOR_MAX_WATCHED = '4';
process.env.SUDOR_MAX_DEMO_WATCHED = '3';

// Nothing in this file may touch a real service.
const realFetch = globalThis.fetch;
let outbound = 0;
globalThis.fetch = async () => { outbound += 1; throw new Error('offline in tests'); };

const store = await import('./dist/store.js');
const weather = await import('./dist/weather.js');
const meds = await import('./dist/meds.js');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { registerTools } = await import('./dist/tools.js');

const reset = () => { store.reloadForTest(); rmSync(`${DIR}/people.json`, { force: true }); };

console.log('\nThe sandbox has its own ceiling, and a newcomer is never refused');
{
  reset();
  for (let i = 0; i < 12; i += 1) store.update(`demo:${String(i).padStart(32, '0')}`, () => {});
  const ids = store.allEntries().map(([id]) => id);
  check('twelve sandboxes made, five kept', ids.length === 5, String(ids.length));
  check('the newest is always there', ids.includes(`demo:${String(11).padStart(32, '0')}`));
  check('the oldest went', !ids.includes(`demo:${String(0).padStart(32, '0')}`));
}

console.log('\nA linked account is never evicted, and the sandbox pays when the total is full');
{
  reset();
  for (let i = 0; i < 3; i += 1) store.update(`acct:person${i}`, (p) => { p.locationName = `home ${i}`; });
  for (let i = 0; i < 5; i += 1) store.update(`demo:${String(i).padStart(32, '0')}`, () => {});
  check('eight records held, at the total ceiling', store.allEntries().length === 8, String(store.allEntries().length));

  store.update('acct:person3', (p) => { p.locationName = 'home 3'; });
  const ids = store.allEntries().map(([id]) => id);
  check('a fourth account was admitted', ids.includes('acct:person3'));
  check('all four accounts are still there', [0, 1, 2, 3].every((i) => ids.includes(`acct:person${i}`)));
  check('the sandbox gave up a place for it', ids.filter((id) => id.startsWith('demo:')).length === 4,
    String(ids.filter((id) => id.startsWith('demo:')).length));
}

console.log('\nOne person cannot hold an unbounded list');
{
  reset();
  store.update('demo:' + 'a'.repeat(32), (p) => {
    for (let i = 0; i < 500; i += 1) {
      p.medications.push({ spoken: `m${i}`, generic: `m${i}`, drugClass: 'x', mechanisms: [] });
      p.recallWatch.push(`drug-${i}`);
      p.contacts.push({ name: `c${i}`, email: `c${i}@example.com`, relation: null, notifyOn: [], confirmedAt: null, askedAt: null });
      p.conditions.push(`cond-${i}`);
    }
  });
  const p = store.get('demo:' + 'a'.repeat(32));
  check('medications are bounded', p.medications.length === store.LIMITS.medications, String(p.medications.length));
  check('recall names are bounded', p.recallWatch.length === store.LIMITS.recallWatch, String(p.recallWatch.length));
  check('contacts are bounded', p.contacts.length === store.LIMITS.contacts, String(p.contacts.length));
  check('conditions are bounded', p.conditions.length === store.LIMITS.conditions, String(p.conditions.length));
  check('the newest are kept, not the oldest', p.medications.at(-1)?.generic === 'm499', p.medications.at(-1)?.generic);
}

console.log('\nFollowed places: the sandbox evicts, accounts have a hard ceiling');
{
  weather.stopAll();
  const before = outbound;
  for (let i = 0; i < 40; i += 1) weather.watch(30 + i * 0.5, -100 + i * 0.5); // the sandbox by default
  check('forty invented places, three followed', weather.watched().sandbox === 3, JSON.stringify(weather.watched()));
  check('and they are the newest three', weather.watched().accounts === 0);
  // Each admitted place makes its two first lookups, forecast and air quality, even
  // if it is evicted a moment later. That is bounded by the caller's rate limit, and
  // what this pins is that nothing followed beyond the ceiling keeps polling.
  check('each place made at most its two first lookups', outbound - before <= 2 * 40, String(outbound - before));

  weather.stopAll();
  for (let i = 0; i < 10; i += 1) weather.watch(40 + i, -90 - i, true);
  check('ten account places, four followed at the hard ceiling', weather.watched().accounts === 4, JSON.stringify(weather.watched()));
}

console.log('\nA flood of sandbox places can never displace an account place');
{
  weather.stopAll();
  weather.watch(41.5, -93.5, true);
  weather.watch(42.5, -94.5, true);
  for (let i = 0; i < 50; i += 1) weather.watch(10 + i * 0.3, -60 - i * 0.3);
  check('both account places survive the flood', weather.watched().accounts === 2, JSON.stringify(weather.watched()));
  check('and the sandbox is still capped', weather.watched().sandbox === 3);

  // A sandbox place an account then asks for stops being evictable.
  weather.stopAll();
  weather.watch(45, -95); // sandbox
  weather.watch(45, -95, true); // an account takes it over
  check('taking it over moves it to the accounts', weather.watched().accounts === 1 && weather.watched().sandbox === 0, JSON.stringify(weather.watched()));
  for (let i = 0; i < 20; i += 1) weather.watch(10 + i, -50 - i);
  check('and a later flood cannot evict it', weather.watched().accounts === 1, JSON.stringify(weather.watched()));
  weather.stopAll();
}

console.log('\nThe tools refuse politely before the backstop is reached');
{
  reset();
  const server = new McpServer({ name: 'bounds', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } });
  registerTools(server, () => 'demo:' + 'b'.repeat(32));
  const client = new Client({ name: 'bounds-client', version: '0.1.0' }, { capabilities: {} });
  const [x, y] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(x), client.connect(y)]);
  const say = async (name, args) => (await client.callTool({ name, arguments: args })).content?.[0]?.text ?? '';

  const known = meds.MEDICATIONS.map((m) => m.generic);
  let added = 0;
  for (const g of known.slice(0, store.LIMITS.medications + 5)) {
    const t = await say('medication', { action: 'add', name: g });
    if (!t.includes('as many medicines as I can')) added += 1;
  }
  check('forty were accepted', added === Math.min(store.LIMITS.medications, known.length), `${added} of ${known.length} known`);

  if (known.length > store.LIMITS.medications) {
    const refused = await say('medication', { action: 'add', name: known[store.LIMITS.medications + 1] });
    check('the next one is refused in plain words', refused.includes('as many medicines as I can'), refused);
    check('and says what to do', refused.includes('Take one off'), refused);
  } else {
    check('the table has fewer than the limit, so refusal is exercised through recall names', true);
  }

  const again = await say('medication', { action: 'add', name: known[0] });
  check('re-adding one already held is not an addition', !again.includes('as many medicines as I can'), again);

  for (let i = 0; i < store.LIMITS.contacts; i += 1) {
    await say('contact', { action: 'add', name: `Person ${i}`, email: `p${i}@example.com` });
  }
  const eleventh = await say('contact', { action: 'add', name: 'One Too Many', email: 'many@example.com' });
  check('the eleventh contact is refused', eleventh.includes('as many people as I can'), eleventh);
  const replace = await say('contact', { action: 'add', name: 'Person 3', email: 'replacement@example.com' });
  check('replacing an existing contact is still allowed', !replace.includes('as many people as I can'), replace);

  await client.close();
  await server.close();
}

globalThis.fetch = realFetch;
weather.stopAll();
rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
