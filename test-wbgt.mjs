// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * The sun, and the scale confusion that would make this dangerous.
 *
 * Two things are being pinned here.
 *
 * The physics: WBGT has to rise with radiation, fall with wind, and collapse to
 * its shade value after dark. Those are directional properties of the published
 * formulas and they are cheap to assert, which makes them worth asserting,
 * because a sign error in either term would still produce a plausible-looking
 * temperature.
 *
 * And the wording: a WBGT and a heat index are different scales. A heat index of
 * 95 is a warm day; a WBGT of 95 is past every occupational limit written. Any
 * sentence that puts the two numbers side by side reads as reassuring and is the
 * reverse of the truth. The tests below refuse to let the raw WBGT number appear
 * in customer-facing text at all.
 */
let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const w = await import('./dist/wbgt.js');

// Ta(F), RH(%), wet bulb(F), solar(W/m2), wind(mph)
const HOT_SUN = [104, 20, 75, 900, 5];
const HOT_DARK = [104, 20, 75, 0, 5];

console.log('\nRadiation raises it, and shade is the part a person can act on');
{
  const sun = w.wbgt(...HOT_SUN);
  const dark = w.wbgt(...HOT_DARK);
  check('sun reads higher than no sun', sun.f > dark.f, `${sun.f} vs ${dark.f}`);
  check('the difference is reported as what shade is worth', sun.sunAddsF > 5, String(sun.sunAddsF));
  check('with no sun there is nothing to gain from shade', dark.sunAddsF === 0, String(dark.sunAddsF));
  check('and it is flagged as an estimate, always', sun.approximate === true && dark.approximate === true);
}

console.log('\nWind lowers it, because evaporation is the whole mechanism');
{
  const calm = w.wbgt(100, 30, 78, 900, 1);
  const breezy = w.wbgt(100, 30, 78, 900, 20);
  check('20 mph reads lower than 1 mph', breezy.f < calm.f, `${breezy.f} vs ${calm.f}`);
}

console.log('\nHumidity raises it, which is where it departs from air temperature');
{
  const dry = w.wbgt(95, 20, 70, 850, 5);
  const humid = w.wbgt(95, 80, 91, 850, 5);
  check('humid reads higher than dry at the same air temperature', humid.f > dry.f, `${humid.f} vs ${dry.f}`);
}

console.log('\nCelsius and Fahrenheit agree with each other');
{
  const r = w.wbgt(...HOT_SUN);
  check('c is the conversion of f', Math.abs(r.c - ((r.f - 32) * 5) / 9) < 0.11, `${r.c} vs ${r.f}`);
}

console.log('\nIt is never below the wet bulb, which would not be physical');
{
  for (const args of [[40, 90, 39, 0, 30], [32, 95, 31, 0, 40], [110, 5, 60, 1200, 0]]) {
    const r = w.wbgt(...args);
    check(`floor holds for ${args.join('/')}`, r.f >= Math.min(args[0], args[2]) - 0.05, String(r.f));
  }
}

console.log('\nBad inputs give null, not a confident wrong number');
{
  check('NaN temperature', w.wbgt(NaN, 50, 70, 500, 5) === null);
  check('NaN wet bulb', w.wbgt(90, 50, NaN, 500, 5) === null);
  check('NaN radiation', w.wbgt(90, 50, 70, NaN, 5) === null);
  check('Infinity', w.wbgt(Infinity, 50, 70, 500, 5) === null);
  check('and explain says nothing for null', w.explain(null) === '');
}

console.log('\nThe wording never puts a WBGT next to a heat index');
{
  const sun = w.wbgt(...HOT_SUN);
  const said = w.explain(sun);
  check('it says something on a hot sunny day', said.length > 0);
  check('it does NOT contain the raw WBGT number', !said.includes(String(Math.round(sun.f))),
    `${said} (wbgt ${Math.round(sun.f)})`);
  check('it never says "heat index"', !said.toLowerCase().includes('heat index'), said);
  check('it does name what shade is worth', said.includes(String(Math.round(sun.sunAddsF))), said);
}

console.log('\nThe NIOSH thresholds gate what is said, and are cited not invented');
{
  check('alert limit is 28 C', w.NIOSH_ALERT_C === 28);
  check('exposure limit is 30 C', w.NIOSH_EXPOSURE_C === 30);

  const severe = w.wbgt(105, 60, 95, 950, 2);
  check('past the exposure limit it says so', severe.c >= 30 && w.explain(severe).includes('exposure limit'),
    `${severe.c} ${w.explain(severe)}`);
  check('and warns the limit was not written for this customer',
    w.explain(severe).includes('not written for someone with your risks'), w.explain(severe));

  const mild = w.wbgt(62, 40, 52, 300, 8);
  check('a mild day says nothing at all', w.explain(mild) === '', `${mild.c}C -> ${w.explain(mild)}`);
}

console.log('\nAfter dark the sun term is gone entirely');
{
  const night = w.wbgt(88, 70, 82, 0, 4);
  check('sun adds nothing', night.sunAddsF === 0);
  check('outdoor equals shade', night.f === night.shadeF, `${night.f} vs ${night.shadeF}`);
  check('and no shade advice is offered', !w.explain(night).includes('shaded side'));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
