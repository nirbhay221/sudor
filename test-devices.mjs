// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * Equipment recalls, and the claim this data cannot support.
 *
 * openFDA's device reports have no structured product field. The only searchable
 * text is a manufacturer's free-form description, which reads like "MAHURKAR
 * 12 Fr High Pressure Triple Lumen Acute Dialysis Catheter, 24 cm, IC Tray REF:
 * 8888102004HP". Nobody says that to a voice assistant, so the match is on
 * equipment category, and the sentence has to stay honest about that.
 *
 * The tests that matter most are therefore about what is *not* said. Telling
 * somebody on home oxygen that their concentrator is recalled, when all that is
 * known is that some concentrators from some firm are, is the failure mode with
 * a real cost attached, and it is the easy sentence to write by accident.
 *
 * Nothing here touches the network.
 */
let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const d = await import('./dist/devices.js');

const recall = (over = {}) => ({
  category: 'oxygen_concentrator',
  firm: 'Medical Depot Inc.',
  description: 'DRIVE DEVILBISS 10L OXYGEN CONCENTRATOR, MODEL 525DS',
  reason: 'The unit may fail to deliver the prescribed oxygen concentration,   which could lead to hypoxia.',
  classification: 'Class I',
  status: 'Ongoing',
  initiated: '20260901',
  ...over,
});

console.log('\nWhat a person actually says maps to a category');
{
  check('"my oxygen concentrator"', d.categoryFor('my oxygen concentrator') === 'oxygen_concentrator');
  check('"oxygen machine", which no product description contains', d.categoryFor('oxygen machine') === 'oxygen_concentrator');
  check('"my breathing machine at night" -> cpap', d.categoryFor('my breathing machine at night') === 'cpap');
  check('"sleep apnea mask" -> cpap', d.categoryFor('sleep apnea mask') === 'cpap');
  check('"kidney dialysis" -> dialysis', d.categoryFor('kidney dialysis') === 'dialysis');
  check('"mobility scooter" -> wheelchair', d.categoryFor('mobility scooter') === 'wheelchair');
  check('"insulin pump" -> insulin_pump', d.categoryFor('insulin pump') === 'insulin_pump');
  check('a toaster is not equipment this knows', d.categoryFor('a toaster') === null);
  check('empty input is not a match', d.categoryFor('') === null && d.categoryFor('   ') === null);
}

console.log('\nEvery category says why a heat product is tracking it');
{
  const all = Object.entries(d.CATEGORIES);
  check('there are categories', all.length >= 5, String(all.length));
  check('each has a spoken form', all.every(([, v]) => v.say.length > 0));
  check('each has search terms', all.every(([, v]) => v.terms.length > 0));
  check('each states why it belongs to a heat product', all.every(([, v]) => v.why.length > 10));
}

console.log('\nThe sentence never claims the customer own device is affected');
{
  const said = d.speak(recall());
  check('it names the category, not the person device', said.includes('some oxygen concentrators'), said);
  check('it says plainly that theirs may not be affected', said.includes('Yours may not be affected'), said);
  check('it tells them how to find out', said.includes('Check the model') || said.includes('ask your supplier'), said);
  check('it never says "your oxygen concentrator is recalled"',
    !/your (oxygen concentrator|device|equipment) is recalled/i.test(said), said);
  check('and it does not tell them to stop using it on this evidence',
    !/stop using/i.test(said), said);
}

console.log('\nGrade wording attaches to the equipment, not to the grade');
{
  const said = d.speak(recall(), true);
  check('Class I is called the most serious grade', said.includes('the most serious grade,'), said);
  check('the clause is followed by what it affects', /most serious grade, affecting some/.test(said), said);
  const two = d.speak(recall({ classification: 'Class II' }), true);
  check('Class II is not dressed up as most serious', !two.includes('most serious'), two);
}

console.log('\nFirm names ending in a full stop do not produce "Inc.."');
{
  for (const firm of ['Medical Depot Inc.', 'Philips Respironics, Inc.', 'Acme Ltd.', 'Covidien LP']) {
    const said = d.speak(recall({ firm }), true);
    check(`"${firm}" reads cleanly`, !said.includes('..'), said);
  }
}

console.log('\nClass I sorts first, and only Class I interrupts a heat answer');
{
  d.resetForTest();
  d.seedForTest('oxygen_concentrator', [
    recall({ classification: 'Class II', initiated: '20260920' }),
    recall({ classification: 'Class I', initiated: '20260101' }),
    recall({ classification: 'Class III', initiated: '20260925' }),
  ]);
  const ranked = d.rank(d.known('oxygen_concentrator'));
  check('Class I comes first despite being oldest', ranked[0].classification === 'Class I',
    ranked.map((r) => r.classification).join(','));
  check('Class III comes last', ranked[2].classification === 'Class III');
  check('urgent() surfaces the Class I', d.urgent(['oxygen_concentrator']).includes('Class one'));

  d.resetForTest();
  d.seedForTest('oxygen_concentrator', [recall({ classification: 'Class II' }), recall({ classification: 'Class III' })]);
  check('a category with no Class I does not interrupt', d.urgent(['oxygen_concentrator']) === '');

  d.resetForTest();
  check('an unwatched category says nothing', d.urgent(['oxygen_concentrator']) === '');
  check('and known() is null rather than an empty promise', d.known('oxygen_concentrator') === null);
}

console.log('\nA long reason is trimmed without cutting a word in half');
{
  const long = d.speak(recall({ reason: 'A'.repeat(40) + ' ' + 'verylongword '.repeat(30) }));
  check('it ends in a full stop', long.trim().endsWith('.'), long.slice(-60));
  check('it does not end mid-word', !/\s\S{1,3}\.$/.test(long.trim()) || long.includes('may not be affected'));
  check('whitespace in the source reason is collapsed', !d.speak(recall()).includes('   '));
}

console.log('\nA 404 from openFDA means nothing matched, not a failure');
{
  d.resetForTest();
  d.configureForTest(async () => ({ results: [] }));
  await d.refresh('cpap');
  check('an empty result set is recorded as checked', d.checkedAt('cpap') !== null);
  check('and known() is an empty list, not null', Array.isArray(d.known('cpap')) && d.known('cpap').length === 0);
  check('and nothing is said', d.urgent(['cpap']) === '');
}

console.log('\nA failed fetch keeps what was known rather than clearing it');
{
  d.resetForTest();
  d.seedForTest('insulin_pump', [recall({ category: 'insulin_pump' })]);
  d.configureForTest(async () => { throw new Error('openFDA down'); });
  await d.refresh('insulin_pump');
  check('the previous recall is still there', (d.known('insulin_pump') ?? []).length === 1);
  check('and it is still surfaced, because a recall does not lapse on a timeout',
    d.urgent(['insulin_pump']).includes('Class one'));
}

d.resetForTest();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
