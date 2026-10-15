#!/usr/bin/env node
/**
 * A Strands agent that carries one request through Sudor's chain of tools.
 *
 * Sudor is an MCP server whose answers each name the step that follows. This is the agent that follows them,
 * built on the Strands Agents SDK (AWS's open agent framework):
 *
 *   1. It connects to Sudor with Strands' MCP client and lists the tools.
 *   2. It reads the Agent Skill from the same connection (skill://sudor-heat-safety/SKILL.md) and uses it, with
 *      the server's own instructions, as its system prompt. The skill is not copied in here.
 *   3. Every tool is wrapped so the model also sees `nextAction` and `flow`, which a plain MCP adapter drops
 *      because they live in the structured half of the result.
 *   4. A tool that saves or sends is refused unless the person has said yes (--yes). That rule is enforced
 *      here, in code, and not left to the prompt.
 *   5. The number of tool calls and the length of the reply are capped, so a run has a known ceiling on cost.
 *
 * Two ways to run it:
 *
 *   node agent.mjs "Is it safe for me to go out?"      with Claude, through Strands' Anthropic provider.
 *                                                       Needs ANTHROPIC_API_KEY, and costs a few cents.
 *   node agent.mjs --plan                               with no language model and no key. A scripted model
 *                                                       starts at one tool and follows each `nextAction`, which
 *                                                       shows the chain end to end for nothing.
 *
 * Options:
 *   --url <mcp url>     the Sudor server. Default http://127.0.0.1:8789/mcp, or SUDOR_URL
 *   --demo              enter the public demo under a throwaway id
 *   --from <tool>       where --plan starts. Default weather_check
 *   --args <json>       the arguments for that first call. Default {}
 *   --yes               the person has agreed to steps that save or send
 *   --steps <n>         the most tool calls in one run. Default 6
 *   --model <id>        the Claude model. Default claude-haiku-5-5, or SUDOR_AGENT_MODEL
 */
import { randomBytes } from 'node:crypto';
import { Agent, FunctionTool, McpClient, Model } from '@strands-agents/sdk';

export const SKILL_URI = 'skill://sudor-heat-safety/SKILL.md';
export const DEFAULT_MODEL = 'claude-haiku-5-5';
export const DEFAULT_STEPS = 6;
const MAX_REPLY_TOKENS = 700;

/** Connects to Sudor and returns what an agent needs from it: the tools, its instructions, and its skill. */
export async function connect({ url, demo = false, transport } = {}) {
  const mcp = new McpClient({
    applicationName: 'sudor-strands-agent',
    applicationVersion: '0.1.0',
    ...(transport ? { transport } : { url: url ?? process.env.SUDOR_URL ?? 'http://127.0.0.1:8789/mcp' }),
    // The public demo lets anyone in under an id of their own making, which is what the demo page does.
    ...(demo ? { headers: { 'x-sudor-demo': randomBytes(16).toString('hex') } } : {}),
  });
  await mcp.connect();
  const tools = await mcp.listTools();
  let skill = '';
  try {
    const got = await mcp.client.readResource({ uri: SKILL_URI });
    skill = got.contents?.[0]?.text ?? '';
  } catch {
    // An older server without the skill: the agent still works from the tool descriptions and instructions.
  }
  return { mcp, tools, skill, instructions: mcp.serverInstructions ?? '' };
}

/** The skill without its frontmatter, then what the server says it already knows about this person. */
export function systemPrompt({ skill, instructions }) {
  const body = skill.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  return [
    'You are speaking for Sudor to one person, aloud. Follow the skill below exactly.',
    'Each tool result is JSON: `say` is the answer to speak, `nextAction` is the next call when there is one,',
    'and `flow` is the chain. When a result has `refused`, tell the person what you would do and ask for their yes.',
    'Finish with the words to say to the person and nothing else.',
    body ? `\n# The skill\n\n${body}` : '',
    instructions ? `\n# What the server says about this person\n\n${instructions}` : '',
  ].filter(Boolean).join('\n');
}

const writes = (tool) => tool.toolSpec?.annotations?.readOnlyHint !== true;

/**
 * Wraps Sudor's tools for the agent. `trace` receives one entry per call, in order, so a run can be shown and
 * checked afterwards: the tool, its arguments, what was said, and what it named next.
 */
export function wrap({ mcp, tools }, { yes = false, steps = DEFAULT_STEPS, trace = [] } = {}) {
  return tools.map((tool) => new FunctionTool({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.toolSpec.inputSchema,
    callback: async (input) => {
      const args = input ?? {};
      if (trace.filter((t) => !t.refused).length >= steps) {
        const stop = { refused: 'limit', say: `That is ${steps} steps, which is the most this run allows. Stop here and say what you have.` };
        trace.push({ tool: tool.name, args, ...stop });
        return stop;
      }
      if (writes(tool) && !yes) {
        const stop = { refused: 'needs_yes', say: `${tool.name} saves or sends something, and the person has not said yes. Ask them first.` };
        trace.push({ tool: tool.name, args, ...stop });
        return stop;
      }
      const raw = await mcp.callTool(tool, args);
      const say = (raw.content ?? []).map((c) => c.text ?? '').join(' ').trim();
      const sc = raw.structuredContent ?? {};
      const out = { say, ...(sc.nextAction ? { nextAction: sc.nextAction } : {}), ...(sc.flow ? { flow: sc.flow } : {}), ...(raw.isError ? { error: true } : {}) };
      trace.push({ tool: tool.name, args, ...out });
      return out;
    },
  }));
}

/**
 * A model that is not a language model: it starts at one tool and then calls whatever `nextAction` the last
 * answer named, until an answer names nothing or a step is refused. It then says the answers in order.
 *
 * It exists so the chain can be run through a real Strands agent loop with no key and no cost. It understands
 * nothing: where it starts is given to it.
 */
export class ChainModel extends Model {
  #config;
  #from;
  #calls = 0;
  #said = [];

  constructor({ from = 'weather_check', args = {} } = {}) {
    super();
    this.#from = { tool: from, arguments: args };
    this.#config = { modelId: 'chain-follower' };
  }

  updateConfig(config) {
    this.#config = { ...this.#config, ...config };
  }

  getConfig() {
    return this.#config;
  }

  async *stream(messages) {
    const last = messages.at(-1);
    const result = last?.content?.find((b) => b.type === 'toolResultBlock');
    const answer = result?.content?.find((b) => b.type === 'jsonBlock')?.json;
    if (answer?.say && !answer.refused) this.#said.push(answer.say);
    const next = this.#calls === 0 ? this.#from : answer && !answer.refused && !answer.error ? answer.nextAction : null;

    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (next) {
      this.#calls += 1;
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: next.tool, toolUseId: `chain-${this.#calls}` } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(next.arguments ?? {}) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
    } else {
      const refused = answer?.refused === 'needs_yes' ? ` ${answer.say}` : '';
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: `${this.#said.join(' ')}${refused}`.trim() || 'Nothing to say.' } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    }
    yield { type: 'modelMetadataEvent', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }
}

/** Claude, through Strands' Anthropic provider. Loaded only when it is used, so --plan needs no key. */
export async function claude({ modelId = process.env.SUDOR_AGENT_MODEL ?? DEFAULT_MODEL, apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Use --plan to follow the chain without a model, at no cost.');
  const { AnthropicModel } = await import('@strands-agents/sdk/models/anthropic');
  return new AnthropicModel({ apiKey, modelId, maxTokens: MAX_REPLY_TOKENS, cacheConfig: { strategy: 'auto' } });
}

/** One request, start to finish. Returns the words to say, the calls made in order, and the tokens used. */
export async function run(utterance, { sudor, model, yes = false, steps = DEFAULT_STEPS } = {}) {
  const trace = [];
  const agent = new Agent({
    name: 'sudor',
    model,
    tools: wrap(sudor, { yes, steps, trace }),
    systemPrompt: systemPrompt(sudor),
    printer: false,
  });
  const result = await agent.invoke(utterance);
  const said = (result.lastMessage?.content ?? []).filter((b) => b.type === 'textBlock').map((b) => b.text).join(' ').trim();
  const usage = result.metrics?.accumulatedUsage ?? null;
  return { said, trace, stopReason: result.stopReason, usage };
}

const flag = (argv, name) => argv.includes(name);
const value = (argv, name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

async function main(argv) {
  const plan = flag(argv, '--plan');
  const taken = new Set(['--url', '--from', '--args', '--steps', '--model'].flatMap((n) => (argv.includes(n) ? [argv.indexOf(n), argv.indexOf(n) + 1] : [])));
  const utterance = argv.filter((a, i) => !a.startsWith('--') && !taken.has(i)).join(' ') || 'Is it safe for me to go out?';
  const steps = Number(value(argv, '--steps') ?? DEFAULT_STEPS);

  const sudor = await connect({ url: value(argv, '--url'), demo: flag(argv, '--demo') });
  try {
    console.log(`Connected to Sudor: ${sudor.tools.length} tools, skill ${sudor.skill ? 'loaded from the server' : 'not found'}.`);
    const model = plan ? new ChainModel({ from: value(argv, '--from') ?? 'weather_check', args: JSON.parse(value(argv, '--args') ?? '{}') }) : await claude({ modelId: value(argv, '--model') });
    console.log(plan ? 'No language model: following each next step the answers name.\n' : `Model: ${model.getConfig().modelId}, at most ${steps} tool calls.\n`);

    const out = await run(utterance, { sudor, model, yes: flag(argv, '--yes'), steps });
    out.trace.forEach((t, i) => {
      console.log(`${i + 1}. ${t.tool}(${JSON.stringify(t.args)})${t.refused ? `  [not run: ${t.refused}]` : ''}`);
      console.log(`   ${t.say}`);
      if (t.nextAction) console.log(`   next: ${t.nextAction.tool}`);
    });
    console.log(`\nSaid to the person:\n${out.said}`);
    if (out.usage && !plan) console.log(`\nTokens: ${out.usage.inputTokens} in, ${out.usage.outputTokens} out.`);
  } finally {
    await sudor.mcp.disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('strands/agent.mjs')) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
