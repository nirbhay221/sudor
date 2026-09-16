/** End-to-end probe against live Open-Meteo and live geocoding, the same shape as Orbita's probe.mjs. */
const URL = 'http://127.0.0.1:8789/mcp';

async function call(method, params) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const t = await r.text();
  const line = t.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : t);
}
const tool = async (name, args = {}) => {
  const t0 = Date.now();
  const r = await call('tools/call', { name, arguments: args });
  return { ms: Date.now() - t0, text: r.result?.content?.[0]?.text ?? JSON.stringify(r.error), s: r.result?.structuredContent };
};
let n = 0;
const show = (label, r) => {
  console.log(`\n${++n}. ${label}  ${r.ms}ms${r.ms > 400 ? '  !! OVER BUDGET' : ''}`);
  console.log(`   ${r.text}`);
};

console.log('='.repeat(74));
console.log('  Sudor, live Open-Meteo weather, air quality and geocoding');
console.log('='.repeat(74));

await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'probe', version: '1' } });

show('Set location by voice, no coordinates', await tool('register_location', { place: 'Phoenix, AZ' }));
show('Ask straight away, while the lookup runs', await tool('weather_check'));

let ready = null;
for (let i = 0; i < 20 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 750));
  const r = await tool('weather_check');
  if (!/still looking|pulling the weather/i.test(r.text)) ready = r;
}
show('Heat check, nothing registered yet', ready);

show('Add metoprolol', await tool('register_medication', { name: 'metoprolol 50mg' }));
show('Add lisinopril', await tool('register_medication', { name: 'lisinopril' }));
show('Add a condition, the way it is said', await tool('register_condition', { condition: 'I have multiple sclerosis' }));

const heat = await tool('weather_check');
show('Is it safe for me outside right now', heat);
console.log(`   place=${heat.s?.place} heatIndex=${heat.s?.heatIndexF} status=${heat.s?.status} sensitivity=${heat.s?.sensitivity}`);

const walk = await tool('plan_my_day', { activity: 'a walk', minutes: 30 });
show('When should I take a walk today', walk);
console.log(`   timezone=${walk.s?.timezone} best=${walk.s?.best?.startLocal ?? 'none'} worst=${walk.s?.worst?.startLocal ?? 'none'}`);

const tomorrow = await tool('plan_my_day', { day: 'tomorrow', activity: 'groceries', minutes: 60 });
show('Plan tomorrow for groceries', tomorrow);

const out = await tool('going_out_now');
show('I have to go out now', out);
if (out.s?.nextStep != null) show('...the rest of the precautions', await tool('going_out_now', { step: out.s.nextStep }));

show('I feel dizzy and I am sweating a lot', await tool('warning_signs', { symptoms: 'I feel dizzy and I am sweating a lot' }));
show('My dad seems confused and his skin is hot and dry', await tool('warning_signs', { symptoms: 'my dad seems confused and his skin is hot and dry' }));
show('Will I burn faster today', await tool('sun_check'));
show('What can you do', await tool('what_can_you_do'));

console.log('\n' + '='.repeat(74));
