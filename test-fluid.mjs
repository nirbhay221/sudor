// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * The drug classes that were missing, and the advice that must not be reused.
 *
 * GLP-1 agonists and SGLT2 inhibitors were both absent from this table. Between
 * them that is Ozempic, Wegovy, Mounjaro, Zepbound, Jardiance and Farxiga: the
 * most-prescribed new drugs in the country and a first-line diabetes class, in a
 * product whose entire premise is that a person's own medicines change what heat
 * does to them. That was a hole, not a rounding error.
 *
 * They lose fluid by routes that have nothing to do with sweating. A GLP-1 slows
 * the stomach and causes nausea, vomiting or loose stools, which both loses fluid
 * and makes somebody unwilling to replace it; the literature ties that to
 * significant dehydration and secondary acute kidney injury. An SGLT2 puts glucose
 * in the urine and free water follows it, and volume depletion is measurably more
 * common over 75, which is much of this audience.
 *
 * So the test that matters most is not that they are present. It is that they do
 * not inherit the electrolyte advice. "Have something salty" is right for a
 * thiazide, where salt is what left. Here it is water that left, by a route that
 * took no salt with it, and repeating the thiazide line would be confidently wrong.
 */
let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const meds = await import('./dist/meds.js');
const domain = await import('./dist/domain.js');

console.log('\nThe GLP-1 class resolves, by generic and by what people actually say');
{
  const cases = [
    ['semaglutide', 'semaglutide'], ['ozempic', 'semaglutide'], ['Wegovy', 'semaglutide'],
    ['rybelsus', 'semaglutide'], ['tirzepatide', 'tirzepatide'], ['Mounjaro', 'tirzepatide'],
    ['zepbound', 'tirzepatide'], ['liraglutide', 'liraglutide'], ['victoza', 'liraglutide'],
    ['dulaglutide', 'dulaglutide'], ['trulicity', 'dulaglutide'], ['exenatide', 'exenatide'],
  ];
  for (const [said, want] of cases) {
    const hit = meds.findMedication(said);
    check(`"${said}" -> ${want}`, hit?.generic === want, hit?.generic ?? 'MISSING');
  }
}

console.log('\nThe SGLT2 class resolves too, and nobody calls these water pills');
{
  for (const [said, want] of [
    ['empagliflozin', 'empagliflozin'], ['jardiance', 'empagliflozin'],
    ['dapagliflozin', 'dapagliflozin'], ['farxiga', 'dapagliflozin'], ['forxiga', 'dapagliflozin'],
    ['canagliflozin', 'canagliflozin'], ['invokana', 'canagliflozin'],
    ['ertugliflozin', 'ertugliflozin'],
  ]) {
    const hit = meds.findMedication(said);
    check(`"${said}" -> ${want}`, hit?.generic === want, hit?.generic ?? 'MISSING');
  }
}

console.log('\nBoth classes carry the fluid mechanism, not the electrolyte one');
{
  for (const name of ['semaglutide', 'tirzepatide', 'empagliflozin', 'dapagliflozin']) {
    const m = meds.findMedication(name);
    check(`${name} is fluid_loss`, m.mechanisms.includes('fluid_loss'), m.mechanisms.join(','));
    check(`${name} is NOT electrolyte_imbalance`, !m.mechanisms.includes('electrolyte_imbalance'));
    check(`${name} is NOT reduced_sweating`, !m.mechanisms.includes('reduced_sweating'));
  }
}

console.log('\nThe advice is steady fluid, and never the salty line');
{
  const said = domain.GUIDANCE.fluid_loss;
  check('there is guidance for it', typeof said === 'string' && said.length > 40);
  check('it says to sip steadily', /sip steadily/i.test(said), said);
  check('it does not tell them to take salt', !/salt|electrolyte drink/i.test(said), said);
  check('it warns that they can be dry before the heat contributes', /before the heat/i.test(said), said);
  // Not keeping fluids down in heat is the escalation, and it has to be said.
  check('it names not keeping fluids down as a reason to call someone',
    /cannot keep fluids down/i.test(said) && /call someone/i.test(said), said);

  // The thiazide advice must still be the thiazide advice.
  check('the electrolyte guidance still mentions an electrolyte drink',
    /electrolyte drink/i.test(domain.GUIDANCE.electrolyte_imbalance));
  check('and the two are different sentences',
    domain.GUIDANCE.fluid_loss !== domain.GUIDANCE.electrolyte_imbalance);
}

console.log('\nIt is spoken in plain words, both as a label and as a verb');
{
  check('the label avoids jargon', /lose fluid/i.test(meds.MECHANISM_LABEL.fluid_loss), meds.MECHANISM_LABEL.fluid_loss);
  check('it says the person would not notice', /notice/i.test(meds.MECHANISM_LABEL.fluid_loss));
  check('the verb form exists for lists', typeof meds.MECHANISM_BASE.fluid_loss === 'string');
  check('and reads as a verb phrase', /^make/i.test(meds.MECHANISM_BASE.fluid_loss), meds.MECHANISM_BASE.fluid_loss);
}

console.log('\nSeverity sits below losing the ability to sweat, above sweating more');
{
  // Ranked, not guessed: it is a real deficit the person is unaware of, but the
  // cooling system still works, so it cannot outrank reduced_sweating.
  const m = meds.findMedication('semaglutide');
  const sweatless = meds.findMedication('metoprolol');
  const worst = domain.worstMechanism
    ? domain.worstMechanism([...m.mechanisms, ...sweatless.mechanisms])
    : null;
  if (worst) check('reduced sweating still outranks fluid loss', worst === 'reduced_sweating', String(worst));
  else console.log('  note  severity ordering is internal, so it is checked through the advice instead');
}

console.log('\nThe table grew rather than being rebuilt');
{
  check('71 medications now: the 57, and 14 added in October 2026 from the CDC classes and FDA labels', meds.MEDICATIONS.length === 71, String(meds.MEDICATIONS.length));
  check('the old entries still resolve', meds.findMedication('lisinopril')?.generic === 'lisinopril');
  check('and metoprolol still blocks sweating',
    meds.findMedication('metoprolol').mechanisms.includes('reduced_sweating'));
  check('hydrochlorothiazide still carries the hyponatremia case',
    meds.findMedication('hydrochlorothiazide').mechanisms.includes('hyponatremia_risk'));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
