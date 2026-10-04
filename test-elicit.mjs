// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * "Did you mean lisinopril?"
 *
 * Drug names are the hardest thing a speech system has to transcribe, and this
 * table contains names that differ by a syllable while doing opposite things to a
 * body in heat. So a near miss is worth asking about, and never worth assuming.
 *
 * The rule these tests exist to hold: a medication is added because the customer
 * confirmed the name, never because an edit distance looked close enough. If the
 * host cannot be asked, the honest "I don't have that in my list" answer has to
 * come back unchanged, because silently substituting a drug somebody did not name
 * would be the worst failure this product could have.
 */
import { mkdirSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

mkdirSync('./data', { recursive: true });
rmSync('./data/test-elicit.json', { force: true });
process.env.SUDOR_DATA = './data/test-elicit.json';

const { canAsk, chooseOne } = await import('./dist/elicit.js');
const { nearMatches, findMedication } = await import('./dist/meds.js');
const store = await import('./dist/store.js');
const { registerTools } = await import('./dist/tools.js');

const host = (respond) => {
  const asked = [];
  return {
    asked,
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: async (params) => { asked.push(params); return respond(params); },
    },
  };
};

console.log('\nNear matches catch a transcription slip, not a different drug');
{
  check('lisinapril -> lisinopril', nearMatches('lisinapril')[0]?.generic === 'lisinopril');
  check('metoprolal -> metoprolol', nearMatches('metoprolal')[0]?.generic === 'metoprolol');
  check('sertralin -> sertraline', nearMatches('sertralin')[0]?.generic === 'sertraline');
  check('hydrochlorothiazid -> hydrochlorothiazide',
    nearMatches('hydrochlorothiazid')[0]?.generic === 'hydrochlorothiazide');
  check('an exact match is not offered as a near match', nearMatches('sertraline').length === 0);
  check('a drug genuinely not in the table gets nothing', nearMatches('xyzzyphylline').length === 0);
  check('a real drug outside the heat table gets nothing', nearMatches('amoxicillin').length === 0);
  check('very short input is never matched', nearMatches('abc').length === 0);
  check('a one-letter slip on a short name is allowed', nearMatches('lasex').length <= 3);
}

console.log('\nThe edit budget scales with length, or short names match everything');
{
  const short = nearMatches('zzzz');
  check('a four-letter nonsense word does not match half the table', short.length <= 1, JSON.stringify(short.map((m) => m.generic)));
  check('at most three suggestions are ever offered', nearMatches('metoprolal', 99).length <= 3);
}

console.log('\nIn the medication tool: a slip is asked about, then accepted');
{
  const build = (server) => {
    const tools = {};
    registerTools({ ...server, registerTool: (name, _cfg, handler) => { tools[name] = handler; } }, () => 'el-test');
    return tools;
  };
  const text = (r) => r.content[0].text;

  store.forget?.('el-test');
  const h = host(async () => ({ action: 'accept', content: { choice: 'lisinopril' } }));
  let tools = build(h);
  const said = text(await tools.medication({ action: 'add', name: 'lisinapril' }));
  check('it asked', h.asked.length === 1, JSON.stringify(h.asked.length));
  check('the question quotes what it heard', h.asked[0].message.includes('lisinapril'), h.asked[0].message);
  check('it offers an escape hatch', h.asked[0].requestedSchema.properties.choice.enum.includes('none of these'));
  check('after confirming, it is treated as the real drug', said.toLowerCase().includes('lisinopril'), said);
  check('and it is not reported as unrecognised', !said.includes("I don't have"), said);

  // "None of these" must land on the honest unknown answer, not on a guess.
  store.forget?.('el-test');
  const n = host(async () => ({ action: 'accept', content: { choice: 'none of these' } }));
  tools = build(n);
  const none = text(await tools.medication({ action: 'add', name: 'lisinapril' }));
  check('"none of these" keeps the honest answer', none.includes("I don't have"), none);
  check('and still says it does not mean the drug is safe', none.includes("doesn't mean it's safe"), none);

  // Declining must not substitute anything either.
  store.forget?.('el-test');
  const d = host(async () => ({ action: 'decline' }));
  tools = build(d);
  const declined = text(await tools.medication({ action: 'add', name: 'lisinapril' }));
  check('declining keeps the honest answer', declined.includes("I don't have"), declined);
  check('and never names the drug it suspected', !declined.includes('lisinopril'), declined);

  // A host that cannot be asked gets exactly the old behaviour.
  store.forget?.('el-test');
  tools = build({});
  const plain = text(await tools.medication({ action: 'add', name: 'lisinapril' }));
  check('no elicitation means the unchanged answer', plain.includes("I don't have"), plain);
  check('and it never silently substitutes the near match', !plain.includes('lisinopril'), plain);
  check('while still watching the recall list for what they said', plain.includes('recall list'), plain);

  // An exact match must never trigger a question.
  store.forget?.('el-test');
  const e = host(async () => ({ action: 'accept', content: { choice: 'lisinopril' } }));
  tools = build(e);
  await tools.medication({ action: 'add', name: 'metoprolol' });
  check('an exact match asks nothing', e.asked.length === 0, JSON.stringify(e.asked.length));
}

console.log('\ncanAsk still refuses hosts that cannot be asked');
{
  check('the plain test harness', canAsk({ registerTool() {} }) === false);
  check('a host with no declared capability',
    canAsk({ server: { elicitInput: async () => ({}), getClientCapabilities: () => ({}) } }) === false);
  check('a host that declares it', canAsk(host(async () => ({ action: 'decline' }))) === true);
  check('an out-of-enum answer is refused',
    (await chooseOne(host(async () => ({ action: 'accept', content: { choice: 'warfarin' } })),
      { message: 'x', label: 'y', values: ['lisinopril'] })).kind === 'unsupported');
}

store.forget?.('el-test');
rmSync('./data/test-elicit.json', { force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
