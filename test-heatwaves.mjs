/**
 * The heat disaster replays, kept passing. evals/heatwaves.mjs runs the people the Multnomah County and Maricopa
 * County reports describe (older, living alone, no working cooling, at home) through Sudor on the days of the
 * Portland heat dome and Phoenix's July 2023, from the archived weather. This checks the replay without writing.
 *
 * The first run found that on Portland's deadliest day, 28 June 2021, 115 outside with a forecast night of 66, the
 * home was only "watch" and the family was not told. The measured older adult limit now makes it "danger".
 */
process.env.HEATWAVES_NO_WRITE = '1';
let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};
const { replay } = await import('./evals/heatwaves.mjs');
const runs = await replay();
const portland = runs.find((r) => r.id === 'portland2021');
const phoenix = runs.find((r) => r.id === 'phoenix2023');

console.log('\nPortland, June 2021');
const day = (id) => portland.results.find((x) => x.day === id);
check('27 June, 112 and a night of 79: the home is too hot to stay in, and the family is told', day('2021-06-27').familyTold, JSON.stringify(day('2021-06-27')));
check('28 June, 115 and a night of 66, the deadliest day: the same, from the measured limit', day('2021-06-28').familyTold && /too hot to stay in/.test(day('2021-06-28').homeLine), day('2021-06-28').homeLine);
check('...and told not to use a fan in that dry heat, but to wet the skin', /do not use one/.test(day('2021-06-28').homeLine) && /wet your skin/.test(day('2021-06-28').homeLine));
check('26 June, 106 and a night of 72: a warning about the home, not yet the family', day('2021-06-26').homeLevel === 'watch' && !day('2021-06-26').familyTold, JSON.stringify(day('2021-06-26')));

console.log('\nPhoenix, July 2023');
for (const x of phoenix.results) check(`${x.day}, ${x.highF} with a night of ${x.overnightLowF}: too hot to stay in, family told`, x.familyTold, JSON.stringify(x));

console.log('\nEvery day of both');
check('the hottest hour is "stay in" for this person', [...portland.results, ...phoenix.results].every((x) => x.hottestHour.status === 'avoid'));
check('the same days with working cooling say nothing about the home', [...portland.results, ...phoenix.results].every((x) => x.controlQuiet));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
