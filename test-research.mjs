/**
 * What the October 2026 research sweep changed, each checked against the source it came from.
 *
 *   The measured limit   Wolf and others (2023): the heat and humidity past which healthy older adults could not
 *                        keep their core temperature from climbing, at rest and doing light everyday things.
 *   Fans and wet skin    NEJM 2024: a fan helps in humid heat and harms in very hot dry heat, wet skin helps;
 *                        JAMA 2024: a fan alone did not lower older adults' peak core temperature at 36 C.
 *   Dementia             heat raised deaths only for people with dementia (J Gerontol A, 2024); the carer is told
 *                        what to do, never the condition.
 *   Young children       the CDC's own steps, planned at the child's sensitivity.
 *   The bill             a working air conditioner left off for the bill is judged as no cooling, with where help
 *                        with the bill is, in the United States only.
 *
 * Nothing here touches the network.
 */
let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const phys = await import('./dist/physiology.js');
const { profileOf, judgeHour, OLDER_LIMIT_REASON } = await import('./dist/personal.js');
const { indoorRisk } = await import('./dist/indoor.js');
const { findCondition, conditionById } = await import('./dist/conditions.js');
const F = (c) => (c * 9) / 5 + 32;

console.log('\nThe measured limit, against the published table');
// Each row of Wolf and others' table, just under and just over the humidity it gives.
for (const [c, light, rest] of [[34, 62.1, 66.5], [36, 53.5, 59.1], [38, 46.1, 53.4], [40, 34.0, 38.8]]) {
  check(`${c} C light activity: under ${light}% is inside, over is past`, !phys.pastOlderLimit(F(c), light - 1, 'light') && phys.pastOlderLimit(F(c), light + 1, 'light'));
  check(`${c} C at rest: under ${rest}% is inside, over is past`, !phys.pastOlderLimit(F(c), rest - 1, 'rest') && phys.pastOlderLimit(F(c), rest + 1, 'rest'));
}
check('below 34 C, where the study did not test, nothing is claimed', !phys.pastOlderLimit(F(33), 95, 'light'));
check('hot and dry: 41 C at 20% is inside the light activity limit, 43 C at 15% is past it', !phys.pastOlderLimit(F(41), 20, 'light') && phys.pastOlderLimit(F(43), 15, 'light'));

console.log('\nWho it applies to, and what it changes');
const hour = (c, rh) => ({ local: '2026-07-15T14:00', time: '2026-07-15T21:00:00Z', tempF: F(c), humidityPct: rh, uvIndex: 0, windMph: 3, isDay: true, aqi: null });
const older = profileOf([], ['older_adult']);
const blocked = profileOf(['reduced_sweating'], []);
const anybody = profileOf([], []);
check('someone 65 or over is under the measured limit', older.olderLimit === 'older');
check('someone whose medicine blocks sweating is too, as lower still', blocked.olderLimit === 'blocked');
check('nobody else is', anybody.olderLimit === null);
const past = judgeHour(hour(36, 60), older);
check('36 C at 60% is a stay in hour for someone 65, with the measured reason', past.status === 'avoid' && past.reasons.includes(OLDER_LIMIT_REASON), JSON.stringify(past));
check('...and the same hour carries no such reason for anybody', !judgeHour(hour(36, 60), anybody).reasons.includes(OLDER_LIMIT_REASON));
check('the sentence says what was measured, and lower still when a medicine blocks sweating',
  /healthy people in their seventies/.test(phys.sayOlderLimit('outside', false)) && /lower still/.test(phys.sayOlderLimit('indoors', true)));

console.log('\nFans and wet skin, by the air and the body');
const snap = (c, rh, extra = {}) => ({
  lat: 33.45, lon: -112.07, fetchedAt: new Date().toISOString(), timezone: 'America/Phoenix', utcOffsetSeconds: -25200,
  tempF: F(c), humidityPct: rh, uvIndex: 0, windMph: 3, isDay: true, aqi: null, wetBulbF: 70, hourly: [], ...extra,
});
const at = new Date().toISOString();
const dryHot = indoorRisk(snap(46, 12), { cooling: 'fan', indoor: { f: 106, at } }, true);
check('very hot and dry indoors: do not use a fan, wet the skin', /do not use one/.test(dryHot?.line ?? '') && /wet your skin/.test(dryHot?.line ?? ''), dryHot?.line);
const olderHumid = indoorRisk(snap(36, 55), { cooling: 'fan', indoor: { f: 96, at }, conditions: ['older_adult'] }, true);
check('someone 65 in humid heat above 95: a fan alone is not enough, wet the skin too', /fan alone/.test(olderHumid?.line ?? '') && /wet your skin/.test(olderHumid?.line ?? ''), olderHumid?.line);
check('...at 96 indoors that air is just inside the limit measured at rest, so that line is not said', !/seventies/.test(olderHumid?.line ?? ''), olderHumid?.line);
const olderPast = indoorRisk(snap(37, 62), { cooling: 'fan', indoor: { f: 98, at }, conditions: ['older_adult'] }, true);
check('...at 98 in more humid air it is past it, and that is said', /in their seventies, sitting at rest/.test(olderPast?.line ?? ''), olderPast?.line);
const privateOlder = indoorRisk(snap(36, 55), { cooling: 'fan', indoor: { f: 96, at }, conditions: ['older_adult'], privacy: true }, true);
check('a private profile hears the fan advice but not the line that gives away their age', /fan alone/.test(privateOlder?.line ?? '') && !/seventies/.test(privateOlder?.line ?? ''), privateOlder?.line);
const youngFan = indoorRisk(snap(33, 60), { cooling: 'fan', indoor: { f: 92, at } }, true);
check('otherwise above 90 a fan helps more with the skin wet', /helps more if you wet your skin/.test(youngFan?.line ?? ''), youngFan?.line);
const noCooling = indoorRisk(snap(33, 60), { cooling: 'none', indoor: { f: 92, at } }, true);
check('with no cooling at all, wet skin is still said', /Wet your skin/.test(noCooling?.line ?? ''), noCooling?.line);

console.log('\nDementia');
const d = conditionById('dementia');
check('"my mum has dementia", "he has Alzheimer\'s" and "memory problems" are all dementia',
  findCondition('my mum has dementia')?.id === 'dementia' && findCondition("he has alzheimer's")?.id === 'dementia' && findCondition('she has memory problems')?.id === 'dementia');
check('it puts someone in the extremely sensitive group', profileOf([], ['dementia']).sensitivity === 'extreme');
check('the plan says they may not notice heat or thirst', /may not notice|stop someone noticing/.test(d.plan), d.plan);
check('the family gets a step of its own that does not name the condition', d.carerStep && !/dementia|alzheimer/i.test(d.carerStep), d.carerStep);
check('both studies are cited', d.sources.length === 2 && d.sources.every((s) => /^https:\/\//.test(s.url)));

console.log('\nYoung children');
const k = conditionById('young_child');
check('"I have a toddler" and "my baby" are a young child', findCondition('I have a toddler')?.id === 'young_child' && findCondition('taking my baby out')?.id === 'young_child');
check('the day is planned at the child\'s sensitivity', profileOf([], ['young_child']).sensitivity === 'sensitive');
check('the CDC\'s car rule comes first, with the 20 degrees in ten minutes', /Never leave them in the car/.test(k.goingOut[0]) && /20 degrees in ten minutes/.test(k.goingOut[0]));
check('...and nappies or diapers as the sign to watch', k.goingOut.some((x) => /wet nappies or diapers/.test(x)));

console.log('\nThe bill');
const hot = { hourly: Array.from({ length: 24 }, (_, i) => ({ local: '', time: new Date(Date.now() + i * 3600e3).toISOString(), tempF: i < 12 ? 108 : 92, humidityPct: 15, uvIndex: 0, windMph: 3, isDay: i < 12, aqi: null })) };
const us = indoorRisk(snap(42, 15, { tempF: 108, ...hot }), { cooling: 'cost', country: 'US' }, true);
check('a working unit left off for the bill is judged as no cooling', us?.level === 'danger' && /Without the air conditioning on/.test(us.line), us?.line);
check('...with the LIHEAP line and the shutoff protections, in the US', /1 866 674 6327/.test(us?.line ?? '') && /19 states/.test(us?.line ?? ''), us?.line);
const uk = indoorRisk(snap(42, 15, { tempF: 108, ...hot }), { cooling: 'cost', country: 'GB' }, true);
check('...and no US numbers anywhere else', uk && !/1 866/.test(uk.line), uk?.line);

console.log('\nAcetaminophen, from the CDC revision of September 2025');
const meds = await import('./dist/meds.js');
const rx = await import('./dist/rxclass.js');
const { GUIDANCE } = await import('./dist/domain.js');
check('"Tylenol", "paracetamol" and "Panadol" are all acetaminophen, hard on the liver in the heat',
  ['tylenol', 'paracetamol', 'panadol'].every((n) => meds.findMedication(n)?.generic === 'acetaminophen' && meds.findMedication(n).mechanisms.join() === 'liver_risk'));
check('the advice is the dose, and not to take it for heat illness', /dose on the packet/.test(GUIDANCE.liver_risk) && /will not bring an overheated body down/.test(GUIDANCE.liver_risk), GUIDANCE.liver_risk);
const rxRow = (name) => ({ rxclassDrugInfoList: { rxclassDrugInfo: [{ minConcept: { name, tty: 'IN' }, rxclassMinConceptItem: { classId: 'N02BE' } }] } });
const otherBrand = rx.parse(rxRow('acetaminophen'));
check('another brand, looked up by its class, gets the same', otherBrand?.mechanisms.join() === 'liver_risk', JSON.stringify(otherBrand));
check('...and only acetaminophen in that class', rx.parse(rxRow('phenacetin')) === null);
check('on its own it counts like ibuprofen: sensitive, never extremely', profileOf(['liver_risk'], []).sensitivity === profileOf(['kidney_risk'], []).sensitivity && profileOf(['liver_risk'], []).sensitivity !== 'extreme', JSON.stringify(profileOf(['liver_risk'], [])));

console.log('\nA pill that is two medicines');
check('RxNorm\'s answer for Tylenol PM is read as both its ingredients', JSON.stringify(rx.ingredientsIn({ rxclassDrugInfoList: { rxclassDrugInfo: [
  { minConcept: { name: 'acetaminophen', tty: 'IN' }, rxclassMinConceptItem: { classId: 'N02BE' } },
  { minConcept: { name: 'diphenhydramine', tty: 'IN' }, rxclassMinConceptItem: { classId: 'D04AA' } },
  { minConcept: { name: 'diphenhydramine', tty: 'IN' }, rxclassMinConceptItem: { classId: 'R06AA' } },
] } })) === '["acetaminophen","diphenhydramine"]');
check('...and one medicine is not a combination', rx.ingredientsIn(rxRow('acetaminophen')) === null);
{
  const { mkdirSync, rmSync } = await import('node:fs');
  const DIR = './data/test-research-combo';
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  process.env.SUDOR_DATA = `${DIR}/people.json`;
  process.env.SUDOR_OUTBOX = `${DIR}/outbox.jsonl`;
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const store = await import('./dist/store.js');
  const { registerTools } = await import('./dist/tools.js');
  const asked = [];
  rx.configureIngredientsForTest(async (name) => { asked.push(name); return name === 'tylenol pm' ? ['acetaminophen', 'diphenhydramine'] : null; });
  rx.configureForTest(async () => null);
  const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {}, resources: {} } });
  registerTools(server, () => 'acct:combo');
  const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const add = async (name, action = 'add') => (await client.callTool({ name: 'medication', arguments: { action, name } })).content.map((c) => c.text).join(' ');
  const generics = () => store.get('acct:combo').medications.map((m) => m.generic).sort().join();
  const pm = await add('Tylenol PM');
  check('"Tylenol PM" adds the acetaminophen and the diphenhydramine that blocks sweating', generics() === 'acetaminophen,diphenhydramine' && /acetaminophen and diphenhydramine/.test(pm), pm);
  await add('Tylenol PM', 'remove');
  check('...and removing it takes both off', generics() === '', generics());
  const norco = await add('Norco');
  check('Norco is hydrocodone and acetaminophen without asking anybody', generics() === 'acetaminophen,hydrocodone' && !asked.includes('norco'), norco);
  await add('Norco', 'remove');
  asked.length = 0;
  await add('lisinopril');
  await add('Zestril');
  check('a name the table holds as said is never sent to be spelled out', asked.length === 0, asked.join());
  rx.configureIngredientsForTest(null);
  rx.configureForTest(null);
  rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
