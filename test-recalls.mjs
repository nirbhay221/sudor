// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * Recalls on the medicines a person actually takes.
 *
 * The FDA is faked here: the point is the judgement around the data, not the
 * feed itself. What matters is that it never tells anyone to stop taking
 * something, that it counts medicines rather than notices, that privacy mode
 * holds the name back, and that a tool call never waits on the network.
 */
import { mkdirSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

mkdirSync('./data', { recursive: true });
rmSync('./data/test-recalls.json', { force: true });
process.env.SUDOR_DATA = './data/test-recalls.json';

const store = await import('./dist/store.js');
const recalls = await import('./dist/recalls.js');
const { registerTools } = await import('./dist/tools.js');

const tools = {};
const who = 'recall-tester';
registerTools({ registerTool: (name, _cfg, handler) => { tools[name] = handler; } }, () => who);
const text = (r) => r.content[0].text;
const structured = (r) => r.structuredContent;

const recall = (generic, classification, started, reason = 'Presence of foreign tablets in sealed bottles.') => ({
  generic, classification, started, reason,
  product: `${generic} tablets USP 20 mg`, lots: 'Lot 8255-3012, Exp 08/31/2027', firm: 'Example Pharma Inc.',
});

let asked = [];
const fakeFda = async (generic) => {
  asked.push(generic);
  if (generic === 'lisinopril') return [recall('lisinopril', 'Class II', '2026-01-15')];
  if (generic === 'furosemide') return [recall('furosemide', 'Class I', '2026-08-01', 'Wrong strength: bottles labelled 20 mg contain 80 mg.')];
  if (generic === 'my special pills') return [recall('my special pills', 'Class III', '2026-03-03')];
  return [];
};
recalls.configureForTest(fakeFda);

console.log('\nBefore anything is known');
check('with no medicines it asks for them', /Tell me your medications/.test(text(await tools.medicine_recalls({}))));
await tools.medication({ action: 'add', name: 'lisinopril' });
recalls.configureForTest(fakeFda); // clears the cache, so nothing has been checked yet
check('a medicine nobody has checked yet is honest about that, rather than clear',
  /haven't managed to check/.test(text(await tools.medicine_recalls({}))), text(await tools.medicine_recalls({})));

console.log('\nOnce the background check has run');
await recalls.refresh('lisinopril', true);
const one = await tools.medicine_recalls({});
check('it names the medicine and when the recall started', /Lisinopril has an open recall, started January 2026/.test(text(one)), text(one));
check('it explains what class two means', /class two/.test(text(one)));
check('it sends them to the lot number, not to the bin', /lot number on your bottle/.test(text(one)));
check('it never tells anyone to stop taking it', /Don't stop taking it on your own/.test(text(one)) && !/stop taking (it|them) (now|immediately)/i.test(text(one)));
check('one medicine means no headline count', !/of your medicines/.test(text(one)), text(one));

console.log('\nA class one recall is treated as more urgent');
await tools.medication({ action: 'add', name: 'Lasix' });
await recalls.refresh('furosemide', true);
const serious = await tools.medicine_recalls({});
check('the most serious recall is read first', /Furosemide has an open recall/.test(text(serious)), text(serious));
check('...and it says to ring the pharmacy today', /Ring your pharmacy today/.test(text(serious)));
check('the milder one is mentioned briefly rather than read out in full', /Lisinopril has one too/.test(text(serious)), text(serious));
check('two affected medicines are counted as two, not as notices', /^2 of your medicines have open recalls/.test(text(serious)), text(serious));

console.log('\nA medicine the heat table does not know is still watched');
const unknown = await tools.medication({ action: 'add', name: 'my special pills' });
check('an unrecognised medicine says so, and says it will still watch recalls',
  /I don't have "my special pills" in my list yet/.test(text(unknown)) && /still watch the FDA recall list/.test(text(unknown)), text(unknown));
check('...and it is kept by name', store.get(who).recallWatch.includes('my special pills'), JSON.stringify(store.get(who).recallWatch));
await recalls.refresh('my special pills', true);
const three = await tools.medicine_recalls({});
check('all three medicines are counted', /^3 of your medicines have open recalls/.test(text(three)), text(three));
check('the rest are offered rather than dumped', /ask me for the rest/.test(text(three)) && structured(three).nextFrom === 2, JSON.stringify(structured(three).nextFrom));
const rest = await tools.medicine_recalls({ from: structured(three).nextFrom });
check('asking for the rest continues instead of repeating', /special pills/i.test(text(rest)), text(rest));

console.log('\nIn a room with other people in it');
await tools.set_privacy({ on: true });
const priv = await tools.medicine_recalls({});
check('privacy mode says there are recalls without naming the medicines',
  /3 of your medicines have open FDA recalls/.test(text(priv)) && !/lisinopril/i.test(text(priv)) && !/furosemide/i.test(text(priv)), text(priv));
await tools.set_privacy({ on: false });

console.log('\nThe rules that keep it inside a voice turn');
const t0 = Date.now();
await tools.medicine_recalls({});
check('the tool answers from memory, in single digit milliseconds', Date.now() - t0 < 50, `${Date.now() - t0} ms`);
asked = [];
await recalls.refresh('lisinopril');
check('a fresh answer is not re-fetched on every call', asked.length === 0, JSON.stringify(asked));

console.log('\nWhen the FDA is unreachable');
recalls.configureForTest(async () => { throw new Error('network down'); });
await recalls.refresh('lisinopril', true);
const down = await tools.medicine_recalls({});
check('a failed check never becomes a false all clear',
  /haven't managed to check/.test(text(down)) || /No open FDA recalls/.test(text(down)) === false, text(down));

recalls.seedForTest('lisinopril', [recall('lisinopril', 'Class II', '2026-01-15')]);
await recalls.refresh('lisinopril', true);
check('...and a failure never erases what was already known',
  /Lisinopril has an open recall/.test(text(await tools.medicine_recalls({}))), text(await tools.medicine_recalls({})));

recalls.configureForTest(null);
rmSync('./data/test-recalls.json', { force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
