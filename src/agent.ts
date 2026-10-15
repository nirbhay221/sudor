/**
 * An Alexa+ stand-in, because Alexa+ cannot be stood in front of a judge.
 *
 * MCP add-on support is in preview and developers have to request access, so this
 * add-on cannot be demonstrated on a real Echo. The demo page has until now been
 * a catalogue of buttons, each hardcoded to a tool and a set of arguments. That
 * proves the server answers; it proves nothing about the part of MCP that is
 * actually hard, because a human wrote the tool name and filled in the arguments.
 *
 * The interesting step is a model reading `tools/list` cold and working out that
 * "I just started taking water pills" means the medication tool with a generic
 * name it had to infer. Amazon's certification list tests that and nothing else:
 * "write clear, unambiguous tool descriptions mapping to distinct customer
 * intents", "include common synonyms, abbreviations and alternate spellings in
 * your tool parameter descriptions and enums", "verify all example utterances
 * work when spoken". A button exercises none of it.
 *
 * So this is a test of the tool descriptions, not of the tools. It matters more
 * here than in most products, because the descriptions are carrying clinical
 * vocabulary: the difference between somebody saying "water pill" and the table's
 * "furosemide" is exactly the gap a tool description has to close.
 *
 * What it is not. It is not Alexa. It does not share Alexa's prompt, its
 * tokenizer, its turn budget or its judgment about when to call something, and a
 * tool description that works here can still fail there. The endpoint says so in
 * its own response payload rather than leaving the disclaimer to a README nobody
 * reads.
 *
 * Two API details worth recording, because both are easy to get wrong:
 *
 * Forced tool use is gone on this model. `tool_choice: {type: "any"}` and
 * `{type: "tool", name}` both return a 400. The instruction to pick a tool has to
 * live in the prompt, with `tool_choice: auto`, and `strict: true` on each tool to
 * keep the arguments schema-valid. Which is the more honest test anyway: a host
 * that is forced to call something cannot demonstrate that it chose correctly, or
 * that it correctly chose nothing.
 *
 * And effort is set to `low`. Picking one tool out of fifteen from a sentence is
 * not a reasoning problem, and the default on this model is `medium`. Low effort
 * also keeps the turn closer to the half second Alexa+ actually allows, which
 * makes the demo an honest picture of the latency rather than a flattering one.
 */

import Anthropic from '@anthropic-ai/sdk';

/** The stand-in is off unless a key is present. The rest of the demo works without it. */
const KEY = process.env.SUDOR_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY ?? '';

/**
 * Sonnet 5.5 by default. Haiku 4.5 was the default for its speed and price, until whole conversations in the
 * patterns real people were recorded using (conversations.mjs) showed it answering one turn in five with a question
 * ("which field?") instead of calling the tool, which is what a visitor to the demo page would meet. Sonnet got all
 * but one turn right, for about twice Haiku's cost, and the demo's daily cap keeps that to cents. Set
 * SUDOR_AGENT_MODEL to test another.
 */
const MODEL = process.env.SUDOR_AGENT_MODEL ?? 'claude-sonnet-5-5';

/**
 * Optional workspace id.
 *
 * Anthropic issues two kinds of key. One is scoped to a workspace and needs
 * nothing extra. The other is not, and every request made with it is refused
 * until it carries an `anthropic-workspace-id` header:
 *
 *   "This API key is not scoped to a workspace, so this request must include
 *    the anthropic-workspace-id header with the ID of the workspace to use."
 *
 * Observed on the first live call this code ever made. Supporting the header is
 * five lines and means whichever key someone already has in hand works, rather
 * than sending them back to the console to make a second one. Unset is the
 * common case and costs nothing.
 */
const WORKSPACE = process.env.SUDOR_ANTHROPIC_WORKSPACE ?? '';

const SYSTEM = [
  'You are standing in for Alexa+ talking to a self-hosted MCP add-on called Sudor.',
  "Sudor checks heat, cold and storms against the customer's own medicines, conditions and home, and says what to do.",
  '',
  'Given what the customer said, call the single most appropriate tool with arguments drawn from their words.',
  'Read the tool descriptions and the parameter descriptions carefully; they name the synonyms customers use.',
  'If no tool fits what they asked, do not call one: say briefly what Sudor cannot do. Guessing a tool is worse',
  'than declining, because a wrong tool produces a confident answer to a question nobody asked.',
  'Do not invent names or places the customer did not say. When they did not say one, call the tool without it:',
  'the add-on remembers what the customer saved and answers itself when something is missing.',
  'Never ask the customer a question before calling a tool, and never list options for them to choose from. If',
  'a tool fits, call it with what they said; its answer asks for anything it still needs, in their own terms.',
].join('\n');

export type ToolDef = { name: string; description?: string; inputSchema?: Record<string, unknown> };

export type Chosen = {
  /** The tool the model picked, or null when it declined to pick one. */
  tool: string | null;
  args: Record<string, unknown>;
  /** Anything the model said alongside the choice. */
  said: string;
  /** Round trip to the model, milliseconds. Shown so the demo is honest about latency. */
  ms: number;
  model: string;
  /** Token counts for this call, so a caller can see what a run costs. */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

export const configured = (): boolean => KEY.length > 0;

let client: Anthropic | null = null;
const anthropic = () =>
  (client ??= new Anthropic({
    apiKey: KEY,
    ...(WORKSPACE ? { defaultHeaders: { 'anthropic-workspace-id': WORKSPACE } } : {}),
  }));

/** Test seam, so tests never reach the API. */
let ask: ((utterance: string, tools: ToolDef[]) => Promise<Chosen>) | null = null;
export function configureForTest(fn: typeof ask): void {
  ask = fn;
}

/**
 * The request exactly as it is sent, in one place so the golden eval can ask the API to count
 * its tokens (free) before spending anything on it.
 */
/** Earlier turns of the same conversation, as a host keeps them: what the customer said, and what the add-on answered. */
export type Turn = { role: 'user' | 'assistant'; text: string };

export function buildRequest(utterance: string, tools: ToolDef[], instructions = '', history: Turn[] = []): Anthropic.MessageCreateParamsNonStreaming {
  const strict = canBeStrict(tools);
  return {
    model: MODEL,
    max_tokens: 2048,
    // The tool list and this prompt are identical on every call, so they are cached: reads cost a tenth
    // of base input. The breakpoint on the system block caches the tools before it as well.
    // The server's own instructions, from its initialize reply, as a real host receives them.
    system: [{ type: 'text', text: instructions ? `${SYSTEM}

The add-on's own instructions:
${instructions}` : SYSTEM, cache_control: { type: 'ephemeral' } }],
    // Low, because choosing one of fifteen tools from a sentence is not a
    // reasoning problem, and the default here is medium.
    // Haiku refuses the effort setting outright ("This model does not support the effort parameter",
    // found live), so it is only sent to the models that take it.
    ...(/haiku/i.test(MODEL) ? {} : { output_config: { effort: 'low' } }),
    // auto, never any/tool: forced tool use returns a 400 on this model, and a
    // host that cannot decline cannot demonstrate that it chose well.
    tool_choice: { type: 'auto' },
    tools: tools.map((t) => {
      const raw = t.inputSchema ?? { type: 'object', properties: {} };
      return {
        name: t.name,
        description: t.description ?? '',
        input_schema: (strict ? strictSchema(raw) : raw) as Anthropic.Tool.InputSchema,
        // Keeps the arguments valid against the schema the server published, so a
        // failure is a choosing failure and not a shape failure. Only when the
        // whole list fits the limit, see canBeStrict.
        ...(strict ? { strict: true } : {}),
      };
    }),
    // A conversation, not one sentence: "and tomorrow?" only means something after the answer before it.
    messages: [...history.filter((h) => h.text.trim()).map((h) => ({ role: h.role, content: h.text })), { role: 'user', content: utterance }],
  } as Anthropic.MessageCreateParamsNonStreaming;
}

/**
 * Decide which tool a sentence means.
 *
 * The MCP tool list arrives in the protocol's own shape and is handed to the
 * model almost unchanged: the schemas are already JSON Schema, which is what the
 * Messages API wants. That is the whole point, and it is worth stating plainly
 * because it is the thing being tested. Nothing here rewrites a description to
 * help the model along. If a description is ambiguous, this demo shows it as
 * ambiguous.
 */
export async function choose(utterance: string, tools: ToolDef[], instructions = '', history: Turn[] = []): Promise<Chosen> {
  if (ask) return ask(utterance, tools);
  if (!configured()) throw new Error('not configured');

  const started = Date.now();
  const response = await anthropic().messages.create(buildRequest(utterance, tools, instructions, history));

  const ms = Date.now() - started;
  const said = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .trim();
  const call = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

  return {
    tool: call?.name ?? null,
    args: (call?.input as Record<string, unknown>) ?? {},
    said,
    ms,
    model: response.model,
    usage: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
      cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

/**
 * The published schema, reduced to what `strict: true` accepts.
 *
 * The server publishes ordinary JSON Schema, with bounds such as minimum and
 * maximum on numbers. Strict tool use refuses those ("For 'number' type,
 * properties maximum, minimum are not supported") and wants every object closed.
 * Found the first time the whole tool list was sent live: every request was a 400,
 * so the demo's stand-in and the golden eval could not have worked against more
 * than a toy schema. The bounds are not lost to the model, they move into the
 * description, and the server still enforces them when the tool is called.
 */
const UNSUPPORTED = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format'];

export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const limits: string[] = [];
  for (const [k, v] of Object.entries(src)) {
    if (UNSUPPORTED.includes(k)) {
      if (k !== 'format' && k !== 'pattern') limits.push(`${k} ${String(v)}`);
      continue;
    }
    if (k === '$schema') continue;
    out[k] = k === 'properties' && v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([n, p]) => [n, strictSchema(p)]))
      : strictSchema(v);
  }
  if (limits.length) {
    const note = `(${limits.join(', ')})`;
    out.description = typeof out.description === 'string' ? `${out.description} ${note}` : note;
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

/**
 * Strict tool use caps the optional parameters across all tools at 24 ("Schemas
 * contains too many optional parameters (26) ... limit: 24", seen live). A server
 * with more than that cannot use it, and the honest fallback is to send the schemas
 * as published and let the server's own validation catch a malformed call, which the
 * golden eval's execution check does. Not a reason to delete parameters that
 * customers use.
 */
export function canBeStrict(tools: ToolDef[]): boolean {
  let optional = 0;
  for (const t of tools) {
    const s = (t.inputSchema ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
    optional += Object.keys(s.properties ?? {}).filter((k) => !(s.required ?? []).includes(k)).length;
  }
  return optional <= 24;
}

/** Typed API errors, turned into something a demo page can show. */
export function explainError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'The stand-in key was rejected.';
  if (err instanceof Anthropic.RateLimitError) return 'The stand-in is rate limited; try again shortly.';
  if (err instanceof Anthropic.BadRequestError) {
    // The one 400 worth explaining rather than echoing, because the fix is a
    // setting and not a code change.
    if (/not scoped to a workspace/.test(err.message)) {
      return 'That API key is not scoped to a workspace. Set SUDOR_ANTHROPIC_WORKSPACE to the workspace id, or use a workspace-scoped key.';
    }
    return `The stand-in request was refused: ${err.message}`;
  }
  if (err instanceof Anthropic.APIError) return `The stand-in failed with ${err.status}.`;
  return 'The stand-in is unavailable.';
}
