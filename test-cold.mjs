// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * The cold half, checked against the National Weather Service's own chart.
 *
 * Wind chill is not a vibe: it is a published formula with published frostbite
 * times hanging off it, so every number here is compared against the chart a
 * forecaster uses.
 */
import { windChillF, frostbiteMinutes, coldCategory, coldMeaning, matchColdFirstAid, COLD_FIRST_AID } from './dist/cold.js';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

console.log('\nWind chill, against the NWS chart');
for (const [tempF, windMph, chart] of [[40, 5, 36], [35, 10, 27], [20, 15, 6], [5, 25, -17], [0, 20, -22], [-10, 30, -39]]) {
  const got = Math.round(windChillF(tempF, windMph));
  check(`${tempF}F with ${windMph} mph wind reads ${chart}`, got === chart, `got ${got}`);
}
check('above 50F the formula does not apply, so the temperature stands', windChillF(55, 20) === 55);
check('below 3 mph there is no wind chill either', windChillF(10, 2) === 10);

console.log('\nFrostbite times, from the chart bands');
check('30 minutes at minus 18', frostbiteMinutes(-18) === 30);
check('10 minutes at minus 32', frostbiteMinutes(-32) === 10);
check('5 minutes at minus 48', frostbiteMinutes(-48) === 5);
check('no time given above the chart bands, which is not the same as safe', frostbiteMinutes(-5) === null);

console.log('\nBands a person would recognise');
check('60 degrees is not a cold question', coldCategory(60) === 'none');
check('45 is chilly, which already matters for some conditions', coldCategory(45) === 'chilly');
check('25 is cold', coldCategory(25) === 'cold');
check('0 is very cold', coldCategory(0) === 'very_cold');
check('minus 20 is dangerous', coldCategory(-20) === 'dangerous');
check('the dangerous band carries a frostbite time out loud', /Frostbite on bare skin in about 30 minutes/.test(coldMeaning(-20)), coldMeaning(-20));

console.log('\nFirst aid, and which one wins');
const cold911 = matchColdFirstAid('he is confused and slurring his words');
check('confusion in the cold is hypothermia', cold911?.id === 'hypothermia');
check('...and it is an emergency', cold911?.emergency === true);
check('...that opens with 911', /^Call 911 now\./.test(cold911.say), cold911.say.slice(0, 40));
check('...and never says to rub the limbs', /do not rub the arms and legs/.test(cold911.say));
const frost = matchColdFirstAid('my fingers are numb and look white');
check('numb white fingers are frostbite', frost?.id === 'frostbite');
check('...and it warns against a radiator, because numb skin burns unnoticed', /never with a fire, radiator or heating pad/.test(frost.say));
check('hypothermia wins when both are described',
  matchColdFirstAid('numb hands and he is confused')?.id === 'hypothermia');
check('nothing matched is null, not a guess', matchColdFirstAid('my knee hurts') === null);
check('every piece of first aid cites a source', COLD_FIRST_AID.every((e) => /^https:\/\//.test(e.source)));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
