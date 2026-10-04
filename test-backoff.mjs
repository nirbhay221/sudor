// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * Not hammering a feed that is down.
 *
 * The property worth pinning is restraint in both directions. A persistent outage has
 * to get cheaper, and a short one must not: two failures in a row are the ordinary
 * weather of the internet and the next attempt has to come on schedule, because a
 * boot that misses its first poll is retried within a minute on purpose.
 *
 * Randomness is injected so the arithmetic can be checked exactly.
 */
let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const { backoff } = await import('./dist/backoff.js');
const MIN = 60_000;
const T0 = 1_000_000_000;

console.log('\nA short outage costs nothing');
{
  const b = backoff({ random: () => 1 });
  check('it starts ready', b.ready(T0));
  b.fail(T0);
  check('one failure does not delay', b.ready(T0));
  b.fail(T0);
  check('two failures do not either', b.ready(T0), JSON.stringify(b.state(T0)));
  check('the failure count is still reported', b.state(T0).failures === 2);
}

console.log('\nA persistent outage backs off, and doubles');
{
  const b = backoff({ random: () => 1 }); // the full ceiling, so the numbers are exact
  b.fail(T0); b.fail(T0); b.fail(T0);
  check('the third failure starts the delay', !b.ready(T0), JSON.stringify(b.state(T0)));
  check('at the base interval of five minutes', b.state(T0).retryInSeconds === 5 * 60, String(b.state(T0).retryInSeconds));
  check('and it is ready once that has passed', b.ready(T0 + 5 * MIN));

  b.fail(T0 + 5 * MIN);
  check('the fourth doubles it to ten', b.state(T0 + 5 * MIN).retryInSeconds === 10 * 60, String(b.state(T0 + 5 * MIN).retryInSeconds));
  b.fail(T0 + 15 * MIN);
  check('the fifth to twenty', b.state(T0 + 15 * MIN).retryInSeconds === 20 * 60);
}

console.log('\nIt has a ceiling');
{
  const b = backoff({ random: () => 1 });
  for (let i = 0; i < 30; i += 1) b.fail(T0);
  check('thirty failures never wait more than an hour', b.state(T0).retryInSeconds === 60 * 60, String(b.state(T0).retryInSeconds));
}

console.log('\nJitter keeps a fleet from returning on the same second');
{
  const low = backoff({ random: () => 0 });
  const high = backoff({ random: () => 1 });
  for (const b of [low, high]) { b.fail(T0); b.fail(T0); b.fail(T0); }
  check('the shortest possible wait is half the ceiling', low.state(T0).retryInSeconds === 150, String(low.state(T0).retryInSeconds));
  check('the longest is all of it', high.state(T0).retryInSeconds === 300, String(high.state(T0).retryInSeconds));
  check('so it is never a formality', low.state(T0).retryInSeconds > 0);
}

console.log('\nOne success puts everything back');
{
  const b = backoff({ random: () => 1 });
  for (let i = 0; i < 8; i += 1) b.fail(T0);
  check('deep in back-off', !b.ready(T0));
  b.ok();
  check('a success clears the delay immediately', b.ready(T0));
  check('and the count', b.state(T0).failures === 0);
  b.fail(T0); b.fail(T0);
  check('the next outage starts from scratch, not from where the last ended', b.ready(T0));
}

console.log('\nThe knobs are honoured');
{
  const b = backoff({ after: 1, baseMs: 1000, capMs: 4000, random: () => 1 });
  b.fail(T0);
  check('after: 1 delays on the first failure', b.state(T0).retryInSeconds === 1);
  b.fail(T0); b.fail(T0); b.fail(T0); b.fail(T0);
  check('and respects a small cap', b.state(T0).retryInSeconds === 4, String(b.state(T0).retryInSeconds));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
