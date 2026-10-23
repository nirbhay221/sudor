/**
 * The signs that are an emergency whatever the weather.
 *
 * Found on 22 October 2026 by saying what frightened people actually say: "she's not breathing", "my dad won't wake
 * up", "he's having chest pain", "her lips are turning blue", "his face is drooping", "she's seizing" and a
 * temperature read out in Celsius all came back as the general description of heat illness, with no "call 911 now".
 * Each is tested here through warning_signs itself, on a hot day and on a freezing one, with the DEFAULT tools.
 */
import { mkdirSync, rmSync } from 'node:fs';

const DIR = './data/test-emergency-signs';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
process.env.SUDOR_DATA = `${DIR}/people.json`;
process.env.SUDOR_OUTBOX = `${DIR}/outbox.jsonl`;
delete process.env.SUDOR_DATA_KEY;
delete process.env.SUDOR_SCOPE;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const weather = await import('./dist/weather.js');
const store = await import('./dist/store.js');
const { triage } = await import('./dist/firstaid.js');
const { registerTools } = await import('./dist/tools.js');
globalThis.fetch = async () => { throw new Error('network is off for this test'); };

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${String(detail).slice(0, 220)}`); }
};

const lat = 44.98, lon = -93.27;
function seedWeather(tempF) {
  const offset = -6 * 3600;
  const local = (ms) => new Date(ms + offset * 1000).toISOString();
  const hourly = [];
  for (const date of [local(Date.now()).slice(0, 10), local(Date.now() + 86_400_000).slice(0, 10)]) {
    for (let h = 0; h < 24; h += 1) {
      const at = `${date}T${String(h).padStart(2, '0')}:00`;
      hourly.push({ local: at, time: weather.localToUtc(at, offset), tempF, humidityPct: 45, uvIndex: 5, windMph: 6, isDay: h >= 6 && h < 19, aqi: 40, solarWm2: 500, wetBulbF: tempF - 15 });
    }
  }
  weather.seedForTest({ lat, lon, fetchedAt: new Date().toISOString(), timezone: 'America/Chicago', utcOffsetSeconds: offset, tempF, humidityPct: 45, uvIndex: 5, windMph: 6, isDay: true, aqi: 40, solarWm2: 500, wetBulbF: tempF - 15, hourly, stale: false });
}

const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {}, resources: {} } });
registerTools(server, () => 'acct:signs');
const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { said: (r.content ?? []).map((c) => c.text ?? '').join(' '), data: r.structuredContent ?? {} };
};
seedWeather(100);
store.update('acct:signs', (p) => { p.lat = lat; p.lon = lon; p.locationName = 'Minneapolis, Minnesota'; p.country = 'US'; p.locationStatus = 'ready'; });

const LIFE = [
  "She's not breathing", 'I can\'t breathe', 'my dad won\'t wake up', 'she fell and isn\'t responding', "he's having chest pain",
  'her lips are turning blue', "his face is drooping and he can't lift his arm", "she's seizing", "he's having a fit",
];

for (const [label, temp] of [['a hot day', 100], ['a freezing day', 5]]) {
  console.log(`\nOn ${label}`);
  seedWeather(temp);
  for (const line of LIFE) {
    const r = await call('warning_signs', { symptoms: line });
    check(`"${line}" is call 911 now`, /Call 911 now/.test(r.said) && r.data.level === 'emergency', r.said);
  }
  const notBreathing = await call('warning_signs', { symptoms: "She's not breathing" });
  check('...and not breathing is told to push on the chest', /push hard and fast/.test(notBreathing.said), notBreathing.said);
  const chest = await call('warning_signs', { symptoms: "he's having chest pain" });
  check('...chest pain is not called heat stroke', !/heat stroke/.test(chest.said), chest.said);
  const strokeSigns = await call('warning_signs', { symptoms: "his face is drooping and he can't lift his arm" });
  check('...a stroke has its time noted', /Note the time/.test(strokeSigns.said), strokeSigns.said);
}

console.log('\nIn the cold, hypothermia still answers for itself');
{
  seedWeather(5);
  const hypo = await call('warning_signs', { symptoms: 'he is confused and his speech is slurred and he stopped shivering' });
  check('hypothermia is still the cold first aid', /hypothermia/.test(hypo.said) && /Call 911/.test(hypo.said), hypo.said);
  const both = await call('warning_signs', { symptoms: "he stopped shivering and he's not breathing" });
  check('hypothermia with no breathing says to push on the chest as well', /hypothermia/.test(both.said) && /push hard and fast/.test(both.said), both.said);
  const frost = await call('warning_signs', { symptoms: 'my fingers are numb and white' });
  check('frostbite alone is not an emergency', frost.data.level !== 'emergency', frost.said);
}

console.log('\nA temperature read out in Celsius');
{
  check('"her temperature is 40 degrees" is an emergency', triage('her temperature is 40 degrees').level === 'emergency');
  check('"his temperature is 39.8C" is an emergency', triage('his temperature is 39.8C').level === 'emergency');
  check('"her temperature is 38 degrees" is not', triage('her temperature is 38 degrees').level !== 'emergency');
  check('"it is 40 degrees outside" is the weather, not a fever', triage("it's 40 degrees outside and I feel weak").level !== 'emergency');
}

console.log('\nWhat was ruled out, or is not an emergency, stays that way');
{
  check('"no chest pain, just a headache" is not an emergency', triage('no chest pain, just a headache').level !== 'emergency');
  check('"he is breathing fine, just tired" is not', triage("he's breathing fine, just tired").level !== 'emergency');
  check('"I feel dizzy" is heat exhaustion', triage('I feel dizzy').level === 'self_care');
  check('"my heart is pounding and I feel sick" is heat exhaustion, with the fast pulse', triage('my heart is pounding and I feel sick').matched.includes('a fast pulse'));
  check('"he is mumbling and does not know where he is" is confusion', triage("he's mumbling and doesn't know where he is").matched.includes('confusion'));
}

await client.close();
rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
