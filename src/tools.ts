import { z } from 'zod';
/**
 * Every tool this add-on publishes, grouped by what it is for.
 *
 * This file used to be 1,386 lines with eighteen tools inside one function. The
 * tools are the same; they now live in one file per job, and this is the index.
 *
 * Registration order is deliberate. A host reads `tools/list` in the order the
 * server declares them, and this order is roughly the order a person meets them:
 * say who you are, say who to tell, then the record, then the conditions, then
 * the judgement built on top of them. `warning_signs` and the first aid it leads
 * to sit inside the judgement group rather than off on their own, because the
 * whole point is that they are reachable from the same conversation as "when
 * should I go out" and not filed somewhere a frightened person has to find.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as profile from './tools/profile.js';
import * as contact from './tools/contact.js';
import { shorten, more, inScope } from './brief.js';
import { say } from './tools/shared.js';
import { takeReplies } from './consent.js';
import * as attention from './attention.js';
import * as store from './store.js';
import * as weather from './weather.js';
import * as outings from './tools/outings.js';
import * as conditions_raw from './tools/conditions_raw.js';
import * as plan from './tools/plan.js';
import * as shovel from './tools/shovel.js';
import * as refuge from './tools/refuge.js';
import * as official from './tools/official.js';
import * as skin from './tools/skin.js';
import * as discovery from './tools/discovery.js';

// Re-exported because server.ts imports it from here, and moving it to
// shared.ts should not make every caller learn the new layout.
export { resolveLocation } from './tools/shared.js';

/**
 * What every answer from this server contains, declared so a host can rely on it.
 *
 * Alexa+'s functional requirements ask for "well-formed responses that conform to your declared schema", and
 * a tool that publishes no outputSchema gives a host nothing to check. The schema is deliberately loose
 * about the rest: each tool adds its own fields (a verdict, a window, the next step) and those stay free to
 * grow, so only the part that is true of every answer is promised, which is the sentence to say aloud.
 */
const SPOKEN_ANSWER = z.object({ spoken: z.string().describe('The answer to say aloud, as written') }).passthrough();

/**
 * The tools that are not part of the one story this add-on tells, which is one person, the weather outside
 * and what they take. Snow shovelling, official warnings, sunburn and recalls are real and tested, and each
 * is a neighbouring product. They are published when SUDOR_SCOPE is "all". See brief.ts.
 *
 * Shelters and storm preparation were on this list and came off it. They are the end of the same story, not
 * a neighbour of it: the day the weather is most dangerous to this person is the day the power is out, and
 * "where can I go" and "what about my medicines" are what they ask then. Asking for help leads to the
 * shelter answer and the shelter answer offers it, so hiding one half made the other a dead end.
 */
export const SECONDARY_TOOLS = ['should_i_shovel', 'weather_warnings', 'sun_check', 'medicine_recalls'] as const;

type Callback = (...args: unknown[]) => unknown;

/** Today's date where this person is, or null when their weather, and so their clock, is not known. */
function localDateOf(id: string): string | null {
  const p = store.get(id);
  if (p.lat == null || p.lon == null) return null;
  const snap = weather.current(p.lat, p.lon);
  return snap ? new Date(Date.now() + snap.utcOffsetSeconds * 1000).toISOString().slice(0, 10) : null;
}

export function registerTools(server: McpServer, personOf: () => string): void {
  const scope = process.env.SUDOR_SCOPE;
  const raw = server.registerTool.bind(server) as (name: string, config: Record<string, unknown>, cb: unknown) => unknown;

  // One wrapper, so no tool can be the one that forgets: an output schema, the published scope, and an answer
  // short enough to listen to (brief.ts).
  (server as unknown as { registerTool: unknown }).registerTool = (name: string, config: Record<string, unknown>, cb: Callback) => {
    if (!inScope(name, SECONDARY_TOOLS, scope)) return undefined;
    const readOnly = (config.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === true;
    const wrapped = async (...args: unknown[]) => {
      const id = personOf();
      type R = { content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
      let result = shorten((await cb(...args)) as Parameters<typeof shorten>[0], id, { readOnly }) as R;
      // Asked the same thing twice in a row: the verdict alone, not the same sixty words. See attention.ts.
      result = attention.onRepeat(id, name, args[0], result, readOnly) as R;
      const sc = result?.structuredContent ?? {};
      // A day planned as a stay-inside day is remembered, to be mentioned until they say they have heard it.
      const best = sc.best as { status?: string } | null | undefined;
      if (name === 'plan_my_day' && sc.day === 'today' && best?.status === 'avoid' && typeof sc.date === 'string') attention.remember(id, sc.date);

      const first = result?.content?.[0];
      if (!first || typeof first.text !== 'string' || result.isError) return result;
      // What is said first, before the answer: a family member's reply to a call for help, then the reminder.
      const news = takeReplies(id);
      const emergency = /\b911\b/.test(first.text);
      const nudge = emergency || sc.heard === true ? '' : attention.reminder(id, localDateOf(id), name);
      const lead = [news, nudge].filter(Boolean).join(' ');
      if (!lead) return result;
      const spoken = `${lead} ${first.text}`;
      return {
        ...result,
        content: [{ ...first, text: spoken }, ...(result.content ?? []).slice(1)],
        structuredContent: { ...sc, spoken, ...(news ? { familyAnswered: news } : {}), ...(nudge ? { reminded: true } : {}) },
      };
    };
    return raw(name, { outputSchema: SPOKEN_ANSWER, ...config }, wrapped);
  };

  profile.register(server, personOf);
  contact.register(server, personOf);
  outings.register(server, personOf);
  conditions_raw.register(server, personOf);
  plan.register(server, personOf);
  shovel.register(server, personOf);
  refuge.register(server, personOf);
  official.register(server, personOf);
  skin.register(server, personOf);
  discovery.register(server, personOf);

  // The rest of the last answer. Registered directly: it is the thing that reads out what was held back, so
  // it must not be shortened itself.
  raw(
    'tell_me_more',
    {
      title: 'Go on',
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
      description:
        'Continue the last answer. Answers are kept short for listening, and the detail is held back until asked ' +
        'for. Call this when the customer says go on, tell me more, why, what else, or the rest, straight after ' +
        'another answer. It takes no arguments and only continues; it does not answer a new question.',
      inputSchema: {},
      outputSchema: SPOKEN_ANSWER,
    },
    async () => {
      const next = more(personOf());
      if (!next) return say('There is nothing more on that. Ask me about the weather, your day, or how you are feeling.', { left: 0 });
      return say(next.left > 0 ? `${next.spoken} There is a little more if you want it.` : next.spoken, { left: next.left });
    },
  );
}
