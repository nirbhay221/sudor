/**
 * The golden eval, tested without a model.
 *
 * eval.mjs costs money and needs a key, so it cannot be part of `npm test`. But most
 * of what can go wrong with an eval is not the model: it is the golden file drifting
 * from the server, or a scorer that miscounts. Both are checked here against the
 * real tools/list, for free, every run.
 */
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { validateGolden, judgeTrial, passHatK, summarise, compare, kindOf } from './evals/lib.mjs';

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
};
const near = (a, b) => Math.abs(a - b) < 1e-9;

const { registerTools } = await import('./dist/tools.js');
const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {}, resources: {} } });
registerTools(server, () => 'golden-test');
const client = new Client({ name: 'c', version: '1' }, { capabilities: {} });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);
const tools = (await client.listTools()).tools;
const golden = JSON.parse(readFileSync('./evals/golden.json', 'utf8'));

console.log('\nThe golden file is consistent with the server it tests');
const v = validateGolden(golden, tools);
ok('every case names a published tool, real parameters and valid enum values', v.problems.length === 0, v.problems.join(' | '));
ok('every tool has at least one case', !v.problems.some((p) => p.includes('has no golden case')));
ok('declining is at least 12% of the set', v.declines / v.cases >= 0.12, `${v.declines}/${v.cases}`);
ok('there are more than 50 cases', v.cases > 50, String(v.cases));
const kinds = new Set(golden.cases.filter((c) => c.say).map(kindOf));
for (const k of ['route', 'decline', 'adversarial', 'asr', 'incomplete', 'colloquial']) ok(`the set has ${k} cases`, kinds.has(k));

console.log('\nThe validator catches a broken golden file (positive controls)');
const bad = (cases) => validateGolden({ cases }, tools).problems;
const base = [{ say: 'what can you do', tool: 'what_can_you_do' }];
ok('a renamed tool is reported', bad([{ say: 'x', tool: 'no_such_tool' }]).some((p) => p.includes('not published')));
ok('an unknown parameter is reported', bad([{ say: 'x', tool: 'medication', args: { nonsense: 1 } }]).some((p) => p.includes('no parameter')));
ok('an enum value nobody can pass is reported', bad([{ say: 'x', tool: 'medication', args: { action: 'levitate' } }]).some((p) => p.includes('not one of')));
ok('a wrong-typed argument is reported', bad([{ say: 'x', tool: 'log_outing', args: { minutes: 'forty' } }]).some((p) => p.includes('number')));
ok('a duplicate sentence is reported', bad([...base, ...base]).some((p) => p.includes('duplicates')));
ok('a missing tool key is reported', bad([{ say: 'x' }]).some((p) => p.includes('no "tool" key')));
ok('a declining case with arguments is reported', bad([{ say: 'x', tool: null, args: { a: 1 } }]).some((p) => p.includes('cannot name arguments')));
ok('a set with no declines is reported', bad(base).some((p) => p.includes('expect no tool')));
ok('a tool with no case is reported', bad(base).some((p) => p.includes('has no golden case')));

console.log('\nThe scorer');
const c1 = { say: 'a', tool: 'medication', args: { action: 'add', name: 'Lasix' } };
ok('right tool, right arguments', (() => { const r = judgeTrial(c1, { tool: 'medication', args: { action: 'Add', name: 'lasix' } }); return r.toolOk && r.argsChecked && r.argWrong.length === 0; })());
ok('right tool, wrong argument is reported by key', (() => { const r = judgeTrial(c1, { tool: 'medication', args: { action: 'remove', name: 'Lasix' } }); return r.toolOk && r.argWrong.length === 1 && r.argWrong[0][0] === 'action'; })());
ok('extra arguments are not penalised', judgeTrial(c1, { tool: 'medication', args: { action: 'add', name: 'Lasix', extra: 'x' } }).argWrong.length === 0);
ok('a missing expected argument is wrong', judgeTrial(c1, { tool: 'medication', args: { action: 'add' } }).argWrong.length === 1);
ok('wrong tool is wrong', !judgeTrial(c1, { tool: 'weather_check', args: {} }).toolOk);
ok('arguments are not scored when the tool was wrong', !judgeTrial(c1, { tool: 'weather_check', args: {} }).argsChecked);
const dec = { say: 'd', tool: null };
ok('declining when asked to is right', judgeTrial(dec, { tool: null, args: {} }).toolOk);
ok('inventing a tool when it should decline is wrong', !judgeTrial(dec, { tool: 'weather_check', args: {} }).toolOk);
ok('numbers compare strictly', judgeTrial({ say: 'n', tool: 'log_outing', args: { minutes: 40 } }, { tool: 'log_outing', args: { minutes: '40' } }).argWrong.length === 1);

console.log('\nTwo defensible answers (alsoOk)');
const amb = { say: 'amb', tool: 'weather_check', alsoOk: ['plan_my_day'] };
ok('the main tool is right', judgeTrial(amb, { tool: 'weather_check', args: {} }).toolOk);
ok('a listed alternative is also right', judgeTrial(amb, { tool: 'plan_my_day', args: {} }).toolOk);
ok('anything else is still wrong', !judgeTrial(amb, { tool: 'what_can_you_do', args: {} }).toolOk);
ok('a case that expects no tool cannot be rescued by alsoOk', !judgeTrial({ say: 'n', tool: null, alsoOk: ['plan_my_day'] }, { tool: 'plan_my_day', args: {} }).toolOk);
ok('an alternative that is not a published tool is reported', bad([{ say: 'x', tool: 'weather_check', alsoOk: ['no_such_tool'] }]).some((p) => p.includes('alsoOk')));
ok('an alternative that repeats the main tool is reported', bad([{ say: 'x', tool: 'weather_check', alsoOk: ['weather_check'] }]).some((p) => p.includes('repeats')));

console.log('\npass^k');
ok('all trials good gives 1', near(passHatK(3, 3, 3), 1));
ok('no trials good gives 0', near(passHatK(3, 0, 3), 0));
ok('two of three, asked for all three, gives 0', near(passHatK(3, 2, 3), 0));
ok('two of three, asked for two, gives 1/3', near(passHatK(3, 2, 2), 1 / 3));
ok('one trial, k of one, is that trial', near(passHatK(1, 1, 1), 1) && near(passHatK(1, 0, 1), 0));
ok('asking for more trials than were run gives 0, not a guess', near(passHatK(2, 2, 3), 0));

console.log('\nSummarising repeated trials');
const t = (toolOk, wrong = []) => ({ toolOk, argsChecked: wrong.length > 0, argWrong: wrong, tool: toolOk ? 'x' : 'y', ms: 1 });
const res = [
  { case: { say: 'stable', tool: 'x' }, trials: [t(true), t(true), t(true)] },
  { case: { say: 'flaky', tool: 'x' }, trials: [t(true), t(false), t(true)] },
  { case: { say: 'never', tool: 'x' }, trials: [t(false), t(false), t(false)] },
  { case: { say: 'argbad', tool: 'x', args: { a: 1 } }, trials: [t(true, [['a', 1]]), t(true, [['a', 1]]), t(true, [['a', 1]])] },
  { case: { say: 'no', tool: null, kind: 'adversarial' }, trials: [t(true), t(true), t(true)] },
];
const s = summarise(res, 3);
ok('stable, flaky and never-right are counted apart', s.stableCases === 2 && s.flakyCases === 1 && s.neverRightCases === 2, JSON.stringify([s.stableCases, s.flakyCases, s.neverRightCases]));
ok('a wrong argument makes a case unstable even when the tool was right', s.perCase.find((p) => p.say === 'argbad').stable === false);
ok('tool accuracy counts trials, not cases', near(s.toolAccuracy, 11 / 15), String(s.toolAccuracy));
ok('argument accuracy counts only trials that were scored on arguments', near(s.argAccuracy, 0), String(s.argAccuracy));
ok('kinds are broken out', s.byKind.adversarial?.cases === 1 && s.byKind.route?.cases === 4);
ok('mean pass^3 is the mean of the cases', near(s.passHatK, 2 / 5), String(s.passHatK));

console.log('\nComparing with a baseline');
const before = summarise(res, 3);
const worse = summarise([{ ...res[0], trials: [t(true), t(false), t(true)] }, ...res.slice(1)], 3);
const cmp = compare(worse, before);
ok('a stable case that turns flaky is a regression, by sentence', cmp.regressions.length === 1 && cmp.regressions[0].say === 'stable');
ok('the drop is reported', cmp.drop > 0);
ok('an improvement is reported as fixed', compare(before, worse).fixed.some((f) => f.say === 'stable'));
ok('no baseline is not an error', compare(before, null).hadBaseline === false);

await client.close(); await server.close();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
