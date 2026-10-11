import * as world from './world.js';
import * as indoor from './indoor.js';
import * as devices from './devices.js';
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
import { shorten, more, inScope, sentences } from './brief.js';
import { say, CARD as CARD_URI } from './tools/shared.js';
import { takeReplies } from './consent.js';
import * as attention from './attention.js';
import { finish } from './finish.js';
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
export const SECONDARY_TOOLS = ['should_i_shovel', 'weather_warnings', 'sun_check'] as const;

/**
 * Tools folded into another one on the default surface.
 *
 * Eighteen tools cost a host about 5,800 tokens before anybody speaks, and Anthropic's guidance on writing
 * tools is to consolidate related operations into fewer tools: fewer, more capable tools are chosen between
 * more reliably. Five of ours were one job, telling the add-on who you are, split by what was being told.
 * They are now `about_me`, which also means "I'm in Tampa and I take Lasix and metoprolol" is one call and
 * not three. Checking on somebody is an action of `share_my_day`.
 *
 * With SUDOR_SCOPE=all the original tools are listed as they always were, and `about_me` is not.
 */
export const MERGED_AWAY = ['register_location', 'medication', 'health_condition', 'set_privacy', 'my_profile', 'check_on', 'medicine_recalls'] as const;

/**
 * Leave the folded tools out of tools/list, and nowhere else.
 *
 * They stay registered and callable, so a host that learned the old names, the demo pages and the other
 * server that calls this one all keep working. Amazon's rule is that every tool listed must be invocable,
 * which holds; it does not say every invocable tool must be listed.
 */
function hideFromList(server: McpServer, hidden: readonly string[]): void {
  const handlers = (server as unknown as { server?: { _requestHandlers?: Map<string, (req: unknown, extra: unknown) => Promise<{ tools?: { name: string }[] }>> } }).server?._requestHandlers;
  const list = handlers?.get('tools/list');
  if (!handlers || !list) return;
  handlers.set('tools/list', async (req, extra) => {
    const res = await list(req, extra);
    return { ...res, tools: (res.tools ?? []).filter((t) => !hidden.includes(t.name)) };
  });
}

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
  const impl = new Map<string, Callback>();
  const merged = (scope ?? 'core').toLowerCase() !== 'all';

  // One wrapper, so no tool can be the one that forgets: an output schema, the published scope, and an answer
  // short enough to listen to (brief.ts).
  (server as unknown as { registerTool: unknown }).registerTool = (name: string, config: Record<string, unknown>, cb: Callback) => {
    if (!inScope(name, SECONDARY_TOOLS, scope)) return undefined;
    impl.set(name, cb);
    const readOnly = (config.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === true;
    const answer = async (...args: unknown[]) => {
      const id = personOf();
      type R = { content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
      // Checking on somebody is asked through the sharing tool. See MERGED_AWAY.
      const run = name === 'share_my_day' && (args[0] as { action?: string } | undefined)?.action === 'check' ? impl.get('check_on') ?? cb : cb;
      let result = shorten((await run(...args)) as Parameters<typeof shorten>[0], id, { readOnly }) as R;
      // Asked the same thing twice in a row: the verdict alone, not the same sixty words. See attention.ts.
      result = attention.onRepeat(id, name, args[0], result, readOnly) as R;
      let sc = result?.structuredContent ?? {};
      // A day planned as a stay-inside day is remembered, to be mentioned until they say they have heard it.
      const best = sc.best as { status?: string } | null | undefined;
      if (name === 'plan_my_day' && sc.day === 'today' && best?.status === 'avoid' && typeof sc.date === 'string') attention.remember(id, sc.date);

      // Say nothing twice, and name the next step. See finish.ts.
      result = finish(name, args[0], result) as R;
      const first = result?.content?.[0];
      if (!first || typeof first.text !== 'string' || result.isError) return result;
      // What is said first, before the answer: a family member's reply to a call for help, then the reminder.
      sc = result.structuredContent ?? {};
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
    // Last of all: the emergency number that works where this person is, in place of 911. See world.ts.
    const wrapped = async (...args: unknown[]) => {
      const result = (await answer(...args)) as { content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> };
      const country = store.get(personOf()).country;
      if (world.inUS(country) || !result?.content) return result;
      return {
        ...result,
        content: result.content.map((c) => (typeof c.text === 'string' ? { ...c, text: world.localise(c.text, country) } : c)),
        ...(result.structuredContent
          ? { structuredContent: JSON.parse(world.localise(JSON.stringify(result.structuredContent), country)) as Record<string, unknown> }
          : {}),
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

  if (merged) {
    type Part = { content?: { text?: string }[]; structuredContent?: Record<string, unknown> };
    (server as unknown as { registerTool: (n: string, c: Record<string, unknown>, cb: Callback) => unknown }).registerTool(
      'about_me',
      {
        title: 'Who I am, where I am and what I take',
        _meta: { ui: { resourceUri: CARD_URI } },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        description:
          'Tell the add-on about the customer, or read back what it knows: where they are, the medicines they take, ' +
          'the health conditions they have, medical equipment they rely on, whether the cooling at home works, and whether to keep those private. Call ' +
          'this when someone says where they live, names a medicine, a condition or equipment such as home oxygen, says their air conditioning is broken or how hot it is indoors, says they have stopped one, asks what you know about them, asks whether a medicine or their equipment has been recalled, asks to ' +
          'keep their health private, or says forget everything. Several things can be given at once. With nothing ' +
          'given it reads the profile back. It records details about the customer only, never about another person. It is not for the weather itself (use weather_check) and not for who to ' +
          'tell in an emergency (use contact).',
        inputSchema: {
          place: z.string().optional().describe('Where the customer themselves lives: a city and state, a city and country, or a US zip code. Never another person\u2019s place'),
          confirmPlace: z.boolean().optional().describe('true only after they said yes to replacing the place already saved'),
          medicines: z.array(z.string()).max(8).optional().describe('Medicines they take, to add, by generic or brand name as spoken'),
          stopMedicines: z.array(z.string()).max(8).optional().describe('Medicines they no longer take, to remove'),
          conditions: z.array(z.string()).max(8).optional().describe('Health conditions they have, to add, the way they say it'),
          stopConditions: z.array(z.string()).max(8).optional().describe('Conditions to remove'),
          cooling: z.enum(['working', 'broken', 'none', 'fan']).optional().describe('The cooling at home, when they say: working, broken (it is there and not working, or they cannot run it), none, or fan when a fan is all they have'),
          topFloor: z.boolean().optional().describe('true when they say they live or sleep on the top floor, in an attic room or right under the roof; false when they say they have moved downstairs'),
          indoorTempF: z.number().min(40).max(130).optional().describe('The temperature inside their home in Fahrenheit, when they read it out'),
          equipment: z.array(z.string()).max(6).optional().describe('Medical equipment they rely on at home, to add, as spoken: oxygen concentrator, CPAP, home dialysis, insulin pump, powered wheelchair'),
          stopEquipment: z.array(z.string()).max(6).optional().describe('Equipment they no longer use, to remove'),
          privacy: z.boolean().optional().describe('true to keep health details out of spoken answers, false to speak openly again'),
          recalls: z.boolean().optional().describe('true when they ask whether any of their medicines or medical equipment has been recalled'),
          forget: z.boolean().optional().describe('true only when they say forget everything or delete my data'),
        },
      },
      async (input: unknown) => {
        const a = (input ?? {}) as { confirmPlace?: boolean; place?: string; medicines?: string[]; stopMedicines?: string[]; conditions?: string[]; stopConditions?: string[]; equipment?: string[]; stopEquipment?: string[]; cooling?: indoor.Cooling; indoorTempF?: number; topFloor?: boolean; privacy?: boolean; recalls?: boolean; forget?: boolean };
        const call = (tool: string, args: Record<string, unknown>) => impl.get(tool)!(args) as Promise<Part>;
        if (a.forget) return call('my_profile', { action: 'forget' });
        // Recalls are asked about what they take and use, so they are asked here. See MERGED_AWAY.
        if (a.recalls) return call('medicine_recalls', {});
        const said: string[] = [];
        const did: { tool: string; [k: string]: unknown }[] = [];
        const step = async (tool: string, args: Record<string, unknown>) => {
          const r = await call(tool, args);
          said.push(r.content?.[0]?.text ?? '');
          const { spoken: _spoken, card: _card, ...rest } = r.structuredContent ?? {};
          did.push({ tool, ...rest });
        };
        if (a.place) await step('register_location', { place: a.place, ...(a.confirmPlace ? { confirm: true } : {}) });
        for (const name of a.medicines ?? []) await step('medication', { action: 'add', name });
        for (const name of a.stopMedicines ?? []) await step('medication', { action: 'remove', name });
        for (const condition of a.conditions ?? []) await step('health_condition', { action: 'add', condition });
        for (const condition of a.stopConditions ?? []) await step('health_condition', { action: 'remove', condition });
        // Equipment is kept by what it is, from the list in devices.ts, and only ever because they said so.
        for (const spoken of a.equipment ?? []) {
          const key = devices.categoryFor(spoken);
          if (!key) {
            said.push(`I don't know "${spoken.slice(0, 40)}" as equipment. I know oxygen concentrators, breathing machines, home dialysis, insulin and infusion pumps, glucose monitors and powered wheelchairs.`);
            did.push({ tool: 'equipment', recognized: false });
            continue;
          }
          store.update(personOf(), (p) => void (p.equipment = [...new Set([...(p.equipment ?? []), key])].slice(0, 8)));
          // And the FDA's device recall list is watched for that kind of equipment from now on.
          devices.watch(key);
          said.push(
            devices.NEEDS_POWER.includes(key)
              ? `Noted your ${devices.OWN[key]}. It needs power, so that comes first when a storm or a power cut is on the way.`
              : `Noted your ${devices.OWN[key]}.`,
          );
          did.push({ tool: 'equipment', recognized: true, equipment: key, needsPower: devices.NEEDS_POWER.includes(key) });
        }
        for (const spoken of a.stopEquipment ?? []) {
          const key = devices.categoryFor(spoken);
          const had = !!key && (store.get(personOf()).equipment ?? []).includes(key);
          if (had) store.update(personOf(), (p) => void (p.equipment = (p.equipment ?? []).filter((k) => k !== key)));
          said.push(had ? `Removed your ${devices.OWN[key!]}.` : `I did not have that down as something you use.`);
          did.push({ tool: 'equipment', removed: had });
        }
        // The cooling at home, and what the thermometer indoors reads. Both are only ever what they said.
        let goSomewhere = false;
        if (a.cooling || typeof a.indoorTempF === 'number' || typeof a.topFloor === 'boolean') {
          const me = personOf();
          store.update(me, (p) => {
            if (a.cooling) p.cooling = a.cooling;
            if (typeof a.topFloor === 'boolean') p.topFloor = a.topFloor;
            if (typeof a.indoorTempF === 'number') p.indoor = { f: a.indoorTempF, at: new Date().toISOString() };
          });
          const p = store.get(me);
          const snap = p.lat != null && p.lon != null ? weather.current(p.lat, p.lon) : null;
          const vulnerable = p.medications.length > 0 || p.conditions.length > 0;
          const risk = snap ? indoor.indoorRisk(snap, p, vulnerable) : null;
          goSomewhere = risk?.level === 'danger';
          said.push(
            risk
              ? risk.line
              : a.cooling === 'working'
                ? 'Good. I will take it that indoors is the cool place for you.'
                : a.cooling
                  ? 'Noted. On a hot day I will not tell you to stay in without saying where else to go.'
                  : typeof a.topFloor === 'boolean'
                    ? (a.topFloor ? 'Noted. The top floor is the hottest part of a building, so on a hot day without cooling I will say so.' : 'Noted.')
                  : `Noted, ${Math.round(a.indoorTempF!)} degrees indoors. That is all right for now.`,
          );
          did.push({ tool: 'home', cooling: p.cooling ?? null, ...(risk ? { indoor: risk.level, basis: risk.basis } : {}) });
        }
        if (typeof a.privacy === 'boolean') await step('set_privacy', { on: a.privacy });
        if (!did.length) return call('my_profile', { action: 'show' });
        const added = !!a.place || !!a.medicines?.length || !!a.conditions?.length;
        // Several things at once repeat the same closing sentence, once each. It is said once, at the end.
        const sentencesSaid = said.filter(Boolean).flatMap((t) => sentences(t));
        const once = sentencesSaid.filter((x, i) => sentencesSaid.lastIndexOf(x) === i);
        // While the town is still being looked up there is no weather to ask about yet, so nothing is pointed at.
        const locating = did.some((d) => d.status === 'locating');
        // A place change waiting on a yes: that yes is the next step, not the weather.
        const asking = did.find((d) => d.status === 'confirm') as { nextAction?: unknown } | undefined;
        if (asking?.nextAction) return say(once.join(' '), { did, nextAction: asking.nextAction });
        if (goSomewhere) return say(once.join(' '), { did, fullAnswer: true, nextAction: { tool: 'somewhere_to_go', arguments: {} } });
        return say(once.join(' '), { did, ...(added && !locating ? { nextAction: { tool: 'weather_check', arguments: {} } } : {}) });
      },
    );
    hideFromList(server, MERGED_AWAY);
  }

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
