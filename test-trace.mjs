// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * Logs you can attach to a bug report.
 *
 * The point of structured logging here is being able to answer "the answer was
 * wrong on Tuesday afternoon" with a query instead of a shrug. The constraint is
 * that this server's arguments are medications, conditions and an address, so a log
 * that records what was asked would be a second copy of the health record, kept
 * somewhere nobody thinks to protect.
 *
 * So the tests that matter here are about what a line does *not* contain. A tool
 * name and a duration are safe. An argument never is.
 */
let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const trace = await import('./dist/trace.js');

console.log('\nTrace ids are short, unique, and pasteable');
{
  const ids = new Set(Array.from({ length: 500 }, () => trace.newTraceId()));
  check('500 ids, no collisions', ids.size === 500, String(ids.size));
  const one = trace.newTraceId();
  check('12 hex characters', /^[0-9a-f]{12}$/.test(one), one);
}

console.log('\nThe subject is correlatable but not reversible');
{
  const a = trace.whoHash('jordan@example.com');
  const b = trace.whoHash('jordan@example.com');
  const c = trace.whoHash('someone.else@example.com');
  check('the same subject hashes the same', a === b, `${a} ${b}`);
  check('a different subject hashes differently', a !== c);
  check('it is short enough to read', a.length === 8, a);
  check('the original does not appear in it', !a.includes('jordan') && !a.includes('example'));
  check('no subject means no field at all', trace.whoHash(null) === undefined && trace.whoHash('') === undefined);
}

console.log('\nAn error contributes its shape, never its message');
{
  const e = new Error('could not find medication furosemide for jordan@example.com');
  const cls = trace.errClass(e);
  check('the class comes through', cls === 'Error', cls);
  check('the medication does not', !cls.includes('furosemide'));
  check('the address does not', !cls.includes('example.com'));

  class RateLimitError extends Error {}
  const r = new RateLimitError('slow down');
  r.status = 429;
  check('a status is appended when there is one', trace.errClass(r) === 'RateLimitError:429', trace.errClass(r));
  check('a non-error still yields something', trace.errClass('a string') === 'Error');
  check('null does not throw', trace.errClass(null) === 'Error');
}

console.log('\nA line carries the tool, never the arguments');
{
  const written = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    trace.log({
      t: new Date().toISOString(),
      id: trace.newTraceId(),
      method: 'tools/call',
      tool: 'medication',
      ms: 19,
      ok: true,
      who: trace.whoHash('jordan@example.com'),
      feeds: { storm: 8, sheltersOpen: 7 },
    });
  } finally {
    process.stdout.write = real;
  }

  check('exactly one line was written', written.length === 1 && written[0].endsWith('\n'));
  const line = written[0];
  const parsed = JSON.parse(line);
  check('it is valid JSON', typeof parsed === 'object');
  check('the tool name is there', parsed.tool === 'medication');
  check('the duration is there', parsed.ms === 19);
  check('the feed ages are there', parsed.feeds.storm === 8);

  // The whole point.
  for (const secret of ['furosemide', 'metoprolol', 'jordan@example.com', 'Phoenix', 'multiple sclerosis']) {
    check(`no "${secret}" in the line`, !line.includes(secret));
  }
  check('undefined keys are dropped, not serialised as null',
    !('err' in parsed), JSON.stringify(parsed));
}

console.log('\nIdempotency keys are taken from where a host would put one');
{
  check('from _meta.idempotencyKey',
    trace.idempotencyKey({ _meta: { idempotencyKey: 'abcd1234efgh' } }) === 'abcd1234efgh');
  check('from _meta.requestId',
    trace.idempotencyKey({ _meta: { requestId: 'req-0001-aaaa' } }) === 'req-0001-aaaa');
  check('from an explicit argument',
    trace.idempotencyKey({ arguments: { clientRequestId: 'client-abc-123' } }) === 'client-abc-123');

  // A counter repeats on every reconnect, so honouring it would make unrelated
  // calls look like retries of each other.
  check('a numeric JSON-RPC id is ignored', trace.idempotencyKey({ id: 1 }) === undefined);
  check('nothing supplied means undefined', trace.idempotencyKey({}) === undefined);
  check('undefined params does not throw', trace.idempotencyKey(undefined) === undefined);
  check('a too-short key is refused', trace.idempotencyKey({ _meta: { idempotencyKey: 'abc' } }) === undefined);
  check('an absurdly long key is refused',
    trace.idempotencyKey({ _meta: { idempotencyKey: 'x'.repeat(200) } }) === undefined);
  check('a non-string key is refused', trace.idempotencyKey({ _meta: { idempotencyKey: 42 } }) === undefined);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
