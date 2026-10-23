/**
 * The second stand-in, for when Claude cannot answer.
 *
 * The demo's model has a workspace spend limit, and once it is spent every turn used to fall straight to the word
 * rules. The word rules answer the demo lines and every emergency, but they match words, so a sentence nobody
 * wrote a rule for is missed. NVIDIA's hosted Nemotron 3 Ultra reads the same tool list and picks the tool instead,
 * up to a fixed number of times per ten days (see standin.ts), and only then do the word rules take over.
 *
 * It only chooses. Measured on 23 October 2026 it took 5 to 10 seconds a call, so a turn here is one call, not the
 * Claude loop: it picks a tool and its arguments, the tool runs, and the tool's own answer is what is said. Nothing
 * this model writes reaches the customer. Anything other than a clean choice of a tool on the list (a chat reply, an
 * unknown tool, arguments that do not parse, an error, a slow answer) returns null or throws, and the caller falls
 * back to the word rules.
 *
 * https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b
 */

import type { ToolDef, Turn, Chosen } from './agent.js';

const KEY = process.env.SUDOR_NVIDIA_KEY ?? '';
const MODEL = process.env.SUDOR_NVIDIA_MODEL ?? 'nvidia/nemotron-3-ultra-550b-a55b';
const ENDPOINT = process.env.SUDOR_NVIDIA_URL ?? 'https://integrate.api.nvidia.com/v1/chat/completions';
const TIMEOUT_MS = Number(process.env.SUDOR_NVIDIA_TIMEOUT_MS ?? 25_000);

export const configured = (): boolean => KEY.length > 0;

export async function choose(utterance: string, tools: ToolDef[], instructions: string, history: Turn[], system: string): Promise<Chosen | null> {
  const started = Date.now();
  const body = {
    model: MODEL,
    temperature: 0,
    max_tokens: 400,
    tool_choice: 'auto',
    messages: [
      { role: 'system', content: instructions ? `${system}\n\nThe add-on's own instructions:\n${instructions}` : system },
      ...history.map((t) => ({ role: t.role, content: t.text })),
      { role: 'user', content: utterance },
    ],
    tools: tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: (t.description ?? '').slice(0, 1024), parameters: t.inputSchema ?? { type: 'object', properties: {} } },
    })),
  };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`NVIDIA answered ${res.status}`);
  const data = (await res.json()) as { choices?: { message?: { tool_calls?: { function?: { name?: string; arguments?: unknown } }[] } }[] };
  const call = data.choices?.[0]?.message?.tool_calls?.[0]?.function;
  const name = call?.name;
  if (!name || !tools.some((t) => t.name === name)) return null;
  let args: unknown;
  try {
    args = typeof call.arguments === 'string' ? (call.arguments.trim() ? JSON.parse(call.arguments) : {}) : (call.arguments ?? {});
  } catch {
    return null;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return { tool: name, args: args as Record<string, unknown>, said: '', ms: Date.now() - started, model: MODEL };
}
