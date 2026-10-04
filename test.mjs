// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
import { heatIndexF, heatCategory, assess, photoRisk, GUIDANCE } from './dist/domain.js';
import { findMedication, MECHANISM_LABEL } from './dist/meds.js';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

console.log('\nHeat index formula, Rothfusz regression sanity checks');
check('below 80F simple-formula floor, heat index stays near the temperature',
  Math.abs(heatIndexF(75, 50) - 75) < 3, heatIndexF(75, 50));
check('a hot, humid day compounds hard: 95F/70%RH lands in danger territory',
  heatIndexF(95, 70) > 115, heatIndexF(95, 70));
check('the same 95F at low humidity is far milder',
  heatIndexF(95, 15) < heatIndexF(95, 70), `${heatIndexF(95, 15)} vs ${heatIndexF(95, 70)}`);
check('heat index rises monotonically with humidity at fixed temperature',
  heatIndexF(90, 30) < heatIndexF(90, 60) && heatIndexF(90, 60) < heatIndexF(90, 90));
check('heat index rises monotonically with temperature at fixed humidity',
  heatIndexF(85, 50) < heatIndexF(95, 50) && heatIndexF(95, 50) < heatIndexF(105, 50));
check('the low-humidity dry-air adjustment actually reduces the index below the raw regression',
  heatIndexF(100, 5) < heatIndexF(100, 13));

console.log('\nNWS category boundaries, from the official heat index chart');
check('79F is not a heat concern', heatCategory(79) === 'none');
check('85F is caution', heatCategory(85) === 'caution');
check('95F is extreme caution', heatCategory(95) === 'extreme_caution');
check('110F is danger', heatCategory(110) === 'danger');
check('130F is extreme danger', heatCategory(130) === 'extreme_danger');
check('category boundaries are half-open and consistent: 90.0 is extreme_caution, not caution',
  heatCategory(90) === 'extreme_caution');

console.log('\nMedication lookup, generic and brand names, dosage noise ignored');
check('generic name resolves', findMedication('lisinopril')?.generic === 'lisinopril');
check('brand name resolves to the generic', findMedication('lasix')?.generic === 'furosemide');
check('common brand for an SSRI resolves', findMedication('zoloft')?.generic === 'sertraline');
check('dosage noise is stripped before matching', findMedication('metoprolol 50mg')?.generic === 'metoprolol');
check('an unknown medication returns null, not a guess', findMedication('made up drug xyz') === null);
check('a thiazide diuretic carries the two mechanisms the CDC assigns it, and the low-sodium one',
  findMedication('hydrochlorothiazide')?.mechanisms.sort().join(',') ===
  ['electrolyte_imbalance', 'hyponatremia_risk', 'photosensitivity'].sort().join(','));
// The advice for this one runs against the usual hot-day line, so it has to say
// the opposite thing plainly rather than adding a caveat to drink more.
check('...and its guidance warns about too much plain water rather than too little',
  /plain water at once can push it lower/.test(GUIDANCE.hyponatremia_risk) && /salty/.test(GUIDANCE.hyponatremia_risk),
  GUIDANCE.hyponatremia_risk);
/*
 * Every guidance line is spliced in after ", so", and a live listen caught two
 * that read "so and heavy sweating" and "so so drinking" out loud. One rule
 * covers the whole table: a guidance line never opens with a connective.
 */
const doubled = Object.entries(GUIDANCE).filter(([, line]) => /^(and|so|but|then)/i.test(line));
check('no guidance line doubles the connective it is spliced onto', !doubled.length, doubled.map(([k]) => k).join(', '));
check('an SSRI carries it too, because that is the other class the reviews name',
  findMedication('sertraline')?.mechanisms.includes('hyponatremia_risk'));
check('a loop diuretic does not, because its problem is a different one',
  !findMedication('furosemide')?.mechanisms.includes('hyponatremia_risk'));

console.log('\nThe verdict: no medications, and a mild day, must not manufacture a risk');
check('no heat concern and no medications: quiet, not alarming',
  assess(75, 40, []).binding === null && assess(75, 40, []).category === 'none');
check('hot day but medications with no heat mechanism: says so plainly',
  assess(100, 50, []).binding === null && assess(100, 50, []).active.length === 0);

console.log('\nReduced sweating outranks every other mechanism, because it removes the warning sign');
const v1 = assess(100, 60, ['electrolyte_imbalance', 'reduced_sweating', 'increased_sweating']);
check('reduced_sweating is named as the binding risk over the others present',
  v1.binding === 'reduced_sweating', v1.binding);
check('the other two are still listed, not silently dropped',
  v1.active.includes('electrolyte_imbalance') && v1.active.includes('increased_sweating'));
check('photosensitivity never appears in a heat verdict, it is a UV question',
  !assess(100, 60, ['photosensitivity']).active.includes('photosensitivity'));
check('a medication that is ONLY photosensitising produces no heat binding at all',
  assess(100, 60, ['photosensitivity']).binding === null);

console.log('\nThe compounding case: cannot feel thirsty while losing fluid fast');
const v2 = assess(100, 60, ['reduced_thirst_or_sedation', 'electrolyte_imbalance']);
check('flagged as compounding', v2.compounding === true);
check('the spoken reason names the compounding risk explicitly', /won't feel thirsty/i.test(v2.reason));
const v3 = assess(100, 60, ['reduced_thirst_or_sedation']);
check('the same mechanism alone, with nothing to compound with, is not flagged', v3.compounding === false);

console.log('\nSun risk is answered on UV, independent of heat, on purpose');
check('no photosensitiser, no risk regardless of UV', !photoRisk(9, false).atRisk);
check('a photosensitiser on a low-UV day is not treated as urgent', !photoRisk(2, true).atRisk);
check('a photosensitiser on a high-UV day is flagged', photoRisk(8, true).atRisk);
check('a cool but high-UV day still triggers the sun warning, which a heat-only check would miss',
  photoRisk(8, true).atRisk && heatCategory(heatIndexF(68, 40)) === 'none');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
