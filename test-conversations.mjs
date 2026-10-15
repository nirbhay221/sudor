/**
 * The conversation runner, run for nothing: the file agrees with the server, and the runner plays every
 * conversation end to end against the real tools with a scripted host that answers as the file says. What the
 * real model makes of the conversations is conversations.mjs, which costs money.
 */
const { FILE, play } = await import('./conversations.mjs');

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

console.log('\nThe file');
const convs = FILE.conversations;
check('there are conversations, each of two turns or more', convs.length >= 12 && convs.every((c) => c.turns.length >= 2), String(convs.length));
check('each names the pattern it comes from', convs.every((c) => typeof c.pattern === 'string' && c.pattern.length > 5));
check('the research it was written from is cited', FILE.sources.some((s) => /2403\.02421/.test(s)) && FILE.sources.some((s) => /2510\.06690/.test(s)));
check('some turns expect no tool at all', convs.some((c) => c.turns.some((t) => t.tool === null)));
check('no em dashes or arrows in what the model is shown', !/[—–→]/.test(JSON.stringify(FILE)));

console.log('\nPlayed against the real tools, with a scripted host');
const asked = [];
let pointer = 0;
const flat = convs.flatMap((c) => c.turns);
const scripted = async (say, tools, _instructions, history) => {
  const turn = flat[pointer++];
  asked.push({ say, history: history.length, names: tools.map((t) => t.name), last: history.at(-1)?.text ?? '' });
  const tool = turn.anyOf ? turn.anyOf[0] : turn.tool ?? null;
  return { tool, args: { ...(turn.args ?? {}) }, said: tool ? '' : 'That is not something I can help with.' };
};
const { summary, results } = await play({ choose: scripted, log: () => {} });
const names = asked[0]?.names ?? [];
check('every tool the file expects is one the server offers by default', flat.every((t) => (t.anyOf ?? [t.tool]).every((x) => x === null || names.includes(x))), flat.flatMap((t) => t.anyOf ?? [t.tool]).filter((x) => x && !names.includes(x)).join());
check('every conversation was played', summary.conversations === convs.length);
check('a scripted host that answers as the file says gets every turn right', summary.turnsRight === summary.turns, JSON.stringify(results.flatMap((r) => r.turns.filter((t) => !t.ok))));
check('each turn after the first was shown the turns before it, with the answers', asked.every((a, i) => a.history === 0 || a.history % 2 === 0) && asked.filter((a) => a.history > 0).length === summary.turns - summary.conversations);
check('the answers in that history are the add-on\'s real answers, from the seeded heat', asked.filter((a) => /degrees|lisinopril|heat/i.test(a.last)).length >= 5, asked.map((a) => a.last.slice(0, 60)).join(' | '));
check('nothing was spent', summary.costUsd === 0);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
