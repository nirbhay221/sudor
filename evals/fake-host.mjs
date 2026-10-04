// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * A deterministic stand-in for the model, preloaded with `node --import`.
 *
 * It exists so the runner itself, not just the scorer, can be tested end to end
 * without an API key: seeding, the trial pool, calling the chosen read-only tool,
 * the report, the baseline and the exit code. It reads the golden file and answers
 * from it, with deliberate faults chosen by FAKE_HOST:
 *
 *   perfect   answers every case as the file says
 *   flaky     gets one routing case wrong on every other trial
 *   inventor  calls a tool for every declining case
 *   broken    picks the right tool but hands it an argument the tool rejects
 */
import { readFileSync } from 'node:fs';

process.env.SUDOR_ANTHROPIC_KEY ||= 'fake-key-for-the-runner-test';
const agent = await import('../dist/agent.js');
const golden = JSON.parse(readFileSync(new URL('./golden.json', import.meta.url), 'utf8'));
const mode = process.env.FAKE_HOST ?? 'perfect';
const table = new Map(golden.cases.filter((c) => c.say).map((c) => [c.say, c]));
const firstRoute = golden.cases.find((c) => c.say && c.tool && !c.args)?.say;
let flip = 0;

/** A real host fills in what the schema requires; so does this, with the dullest valid value. */
function fillRequired(tool, args, tools) {
  const schema = tools.find((t) => t.name === tool)?.inputSchema ?? {};
  for (const k of schema.required ?? []) {
    if (args[k] !== undefined) continue;
    const p = schema.properties?.[k] ?? {};
    args[k] = p.enum ? p.enum[0] : p.type === 'number' || p.type === 'integer' ? 1 : p.type === 'boolean' ? true : 'x';
  }
  return args;
}

/** Some other read-only tool, so a deliberate wrong choice is never accidentally the right one. */
function other(tools, not) {
  return tools.find((x) => x.annotations?.readOnlyHint && x.name !== not).name;
}

agent.configureForTest(async (utterance, tools) => {
  const c = table.get(utterance);
  const out = { tool: c.tool, args: { ...(c.args ?? {}) }, said: '', ms: 1, model: 'fake', usage: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0 } };
  if (mode === 'flaky' && utterance === firstRoute && flip++ % 2 === 0) out.tool = other(tools, c.tool);
  if (mode === 'inventor' && c.tool === null) out.tool = other(tools, c.tool);
  if (out.tool) fillRequired(out.tool, out.args, tools);
  if (mode === 'broken' && c.tool === 'medication') out.args = { action: 'not_a_real_action', name: 'x' };
  return out;
});
