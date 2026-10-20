import { reachable } from './consent.js';
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
import { say, CARD as CARD_URI, HEALTH_PURPOSE, settle, nowHour, profileFor } from './tools/shared.js';
import { judgeHour } from './personal.js';
import { takeReplies } from './consent.js';
import * as attention from './attention.js';
import { checkHotHome, checkColdHome } from './alerts.js';
import * as indoorCold from './indoorcold.js';
import { billHelp } from './aid.js';
import * as impact from './impact.js';
import { canEmailFor } from './notify.js';
import * as flow from './flow.js';
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
import * as week from './tools/week.js';

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

const andWords = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

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
      // Any word from them is a check-in. See checkOnAlone in alerts.ts.
      if (!id.startsWith('demo:')) store.update(id, (p) => void (p.lastSeenAt = new Date().toISOString()));
      type R = { content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
      // "I'm in Fairbanks, the power's out, where can I go?" came as one call to somewhere_to_go with the town in it,
      // and was answered "I don't know where you are yet". A place said with it, and none saved, is saved first.
      if (name === 'somewhere_to_go') {
        const said = (args[0] as { place?: string } | undefined)?.place?.trim();
        if (said && store.get(id).lat == null) {
          await impl.get('register_location')?.({ place: said });
          await settle(id, 3500);
        }
      }
      // Checking on somebody is asked through the sharing tool. See MERGED_AWAY.
      const run = name === 'share_my_day' && (args[0] as { action?: string } | undefined)?.action === 'check' ? impl.get('check_on') ?? cb : cb;
      let result = shorten((await run(...args)) as Parameters<typeof shorten>[0], id, { readOnly }) as R;
      // Asked the same thing twice in a row: the verdict alone, not the same sixty words. See attention.ts.
      result = attention.onRepeat(id, name, args[0], result, readOnly) as R;
      let sc = result?.structuredContent ?? {};
      // A day planned as a stay-inside day is remembered, to be mentioned until they say they have heard it.
      const best = sc.best as { status?: string } | null | undefined;
      if (name === 'plan_my_day' && sc.day === 'today' && best?.status === 'avoid' && typeof sc.date === 'string') {
        attention.remember(id, sc.date);
        impact.count('warned', id);
      }
      // Told to leave a home that is too hot: asked later whether they went. Looking for somewhere ends it.
      const toldToLeave = (sc.nextAction as { tool?: string } | undefined)?.tool === 'somewhere_to_go' && name !== 'somewhere_to_go' && name !== 'storm_prep';
      const today = localDateOf(id);
      if (toldToLeave && today && !result.isError) {
        attention.sentAway(id, today);
        impact.count('sentAway', id);
      }
      // Counted as acting on it only when they had been sent away. See impact.ts.
      if (name === 'somewhere_to_go' && attention.wentLooking(id)) impact.count('wentLooking', id);

      // Say nothing twice, and name the next step. See finish.ts.
      result = finish(name, args[0], result) as R;
      // The chain this answer is on: what was just done, the next step, and the ones after. See flow.ts.
      {
        const sc0 = result?.structuredContent;
        if (sc0 && !result.isError) {
          let next = (sc0.nextAction ?? null) as { tool: string; arguments: Record<string, unknown> } | null;
          // Help was asked for and nowhere to go has been looked for yet: that is the next question.
          if (!next && name === 'get_help' && sc0.status !== 'safe' && !flow.trail(id).includes('somewhere_to_go')) next = { tool: 'somewhere_to_go', arguments: {} };
          const chain = flow.describe(id, name, next);
          if (chain || (next && !sc0.nextAction)) {
            result = { ...result, structuredContent: { ...sc0, ...(next && !sc0.nextAction ? { nextAction: next } : {}), ...(chain ? { flow: chain } : {}) } } as R;
          }
        }
      }
      const first = result?.content?.[0];
      if (!first || typeof first.text !== 'string' || result.isError) return result;
      // What is said first, before the answer: a family member's reply to a call for help, then the reminder.
      sc = result.structuredContent ?? {};
      const news = takeReplies(id);
      const emergency = /\b911\b/.test(first.text);
      const nudge = emergency || sc.heard === true ? '' : attention.reminder(id, localDateOf(id), name);
      const asked = emergency ? '' : attention.followUp(id, localDateOf(id), name);
      if (asked) impact.count('followedUp', id);
      const lead = [news, asked, nudge].filter(Boolean).join(' ');
      if (!lead) return result;
      const spoken = `${lead} ${first.text}`;
      return {
        ...result,
        content: [{ ...first, text: spoken }, ...(result.content ?? []).slice(1)],
        structuredContent: {
          ...sc,
          spoken,
          ...(news ? { familyAnswered: news } : {}),
          ...(nudge ? { reminded: true } : {}),
          // The question asked first has its own answer: somewhere to go, unless this answer already names a step.
          ...(asked ? { followedUp: true, ...(sc.nextAction ? {} : { nextAction: { tool: 'somewhere_to_go', arguments: {} } }) } : {}),
        },
      };
    };
    // Last of all: the emergency number that works where this person is, in place of 911. See world.ts.
    const wrapped = async (...args: unknown[]) => {
      const result = (await answer(...args)) as { content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> };
      const who = store.get(personOf());
      const country = who.country;
      // Nowhere known yet: "My mother just fainted", from somebody in São Paulo, was told to call 911. Until there
      // is a place, the number is said with the words that make it right anywhere.
      if (who.lat == null && !country && result?.content) {
        return {
          ...result,
          content: result.content.map((c) => (typeof c.text === 'string' ? { ...c, text: (/[Cc]all 911\b/.test(c.text) ? c.text.replace(/([Cc]all) 911\b/, '$1 911, or your local emergency number,') : c.text.replace(/\b911\b/, '911, or your local emergency number,')).replace(/number, ([.!?])/, 'number$1') } : c)),
        };
      }
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
  week.register(server, personOf);
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
          'the health conditions they have, medical equipment they rely on, whether the cooling and the heating at home work, and whether to keep those private. Call ' +
          'this when someone says where they live, names a medicine, a condition or equipment such as home oxygen, says their air conditioning or heating is broken, that they cannot afford to heat or cool, or how hot or cold it is indoors, says they have stopped one, asks what you know about them, asks whether a medicine or their equipment has been recalled, asks to ' +
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
          cooling: z.enum(['working', 'broken', 'none', 'fan', 'power_cuts', 'cost']).optional().describe('The cooling at home, when they say: working, broken (it is there and not working), cost (it works but they cannot afford to run it, or keep it off for the bill), none, power_cuts when the power keeps going off (load shedding), or fan when a fan is all they have'),
          heating: z.enum(['working', 'broken', 'none', 'cost', 'power_cuts', 'space_heater']).optional().describe('The heating at home, when they say: working, broken (the furnace or boiler is out), cost (it works but they cannot afford to run it, or keep it low for the bill), none, power_cuts when the power keeps going off, or space_heater when a portable heater is all they have'),
          livesAlone: z.boolean().optional().describe('true when they say they live alone, false when somebody lives with them'),
          age: z.number().int().min(1).max(120).optional().describe('Their own age in years, when they say it: "I am seventy four" is 74. Never a child\'s age'),
          noMedicines: z.boolean().optional().describe('true when they say they take no medicines at all'),
          noConditions: z.boolean().optional().describe('true when they say they have no health conditions'),
          checkInBy: z.number().int().min(6).max(20).optional().describe('The hour, 24 hour clock, by which their family should be asked to check if they have not spoken to the add-on on a dangerous day, when they say so: "check on me if you have not heard from me by eleven" is 11'),
          topFloor: z.boolean().optional().describe('true when they say they live or sleep on the top floor, in an attic room or right under the roof; false when they say they have moved downstairs'),
          indoorTempF: z.number().min(30).max(130).optional().describe('The temperature inside their home in Fahrenheit, when they read it out, hot or cold'),
          equipment: z.array(z.string()).max(6).optional().describe('Medical equipment they rely on at home, to add, as spoken: oxygen concentrator, CPAP, home dialysis, insulin pump, powered wheelchair'),
          stopEquipment: z.array(z.string()).max(6).optional().describe('Equipment they no longer use, to remove'),
          privacy: z.boolean().optional().describe('true to keep health details out of spoken answers, false to speak openly again'),
          recalls: z.boolean().optional().describe('true when they ask whether any of their medicines or medical equipment has been recalled'),
          forget: z.boolean().optional().describe('true only when they say forget everything or delete my data'),
        },
      },
      async (input: unknown) => {
        const a = (input ?? {}) as { confirmPlace?: boolean; place?: string; medicines?: string[]; stopMedicines?: string[]; conditions?: string[]; stopConditions?: string[]; equipment?: string[]; stopEquipment?: string[]; cooling?: indoor.Cooling; heating?: indoorCold.Heating; indoorTempF?: number; topFloor?: boolean; livesAlone?: boolean; checkInBy?: number; age?: number; noMedicines?: boolean; noConditions?: boolean; privacy?: boolean; recalls?: boolean; forget?: boolean };
        const call = (tool: string, args: Record<string, unknown>) => impl.get(tool)!(args) as Promise<Part>;
        // "None" is an answer, not a medicine or a condition called "none". A model can pass it either way, and it
        // was kept as a condition named "none". Blank names are dropped too.
        const NONE = /^\s*(none|no|nothing|nil|n\/?a|no (medicines?|medications?|conditions?|pills)|i don'?t( take any| have any)?)\s*\.?\s*$/i;
        for (const [list, flag] of [['medicines', 'noMedicines'], ['conditions', 'noConditions']] as const) {
          const said = a[list];
          if (!Array.isArray(said)) continue;
          const kept = said.filter((x) => typeof x === 'string' && x.trim() && !NONE.test(x));
          if (said.some((x) => typeof x === 'string' && NONE.test(x)) && !kept.length) a[flag] = true;
          a[list] = kept.length ? kept : undefined;
        }
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
        /*
         * Many Echo devices carry a temperature sensor, and an Alexa routine can start when the room passes a
         * temperature. That is the one thing that watches the house while nobody is asking, so it is suggested
         * to somebody without working cooling. 79 is Health Canada's upper indoor limit for older adults (26 C),
         * the same line indoor.ts uses. The routine is theirs to set up: this add-on cannot create one.
         */
        const ROUTINE = ' If your Echo has a temperature sensor, ask Alexa for a routine that tells you when this room passes 79 degrees and turns on your fan if it is on a smart plug.';
        // The cooling at home, and what the thermometer indoors reads. Both are only ever what they said.
        let goSomewhere = false;
        if (a.cooling || a.heating || typeof a.indoorTempF === 'number' || typeof a.topFloor === 'boolean') {
          const me = personOf();
          store.update(me, (p) => {
            if (a.cooling) p.cooling = a.cooling;
            if (a.heating) p.heating = a.heating;
            if (typeof a.topFloor === 'boolean') p.topFloor = a.topFloor;
            if (typeof a.indoorTempF === 'number') p.indoor = { f: a.indoorTempF, at: new Date().toISOString() };
          });
          const p = store.get(me);
          const snap = p.lat != null && p.lon != null ? weather.current(p.lat, p.lon) : null;
          const vulnerable = p.medications.length > 0 || p.conditions.length > 0;
          const risk = snap ? indoor.indoorRisk(snap, p, vulnerable) : null;
          // The winter half: a home that cannot stay warm. Judged only when the heat question has nothing to say.
          const chill = !risk && snap ? indoorCold.coldHomeRisk(snap, p) : null;
          goSomewhere = risk?.level === 'danger' || chill?.level === 'danger';
          // A home too hot to stay in is the moment the family should hear, once a day. See checkHotHome.
          const family = goSomewhere ? p.contacts.filter((c) => reachable(c) && c.notifyOn.includes('hot_day')).map((c) => c.name) : [];
          if (family.length && canEmailFor(me)) void (chill ? checkColdHome(new Date(), me) : checkHotHome(new Date(), me)).catch((err) => console.error('[alerts]', err));
          const telling = family.length && canEmailFor(me) ? ` I am letting ${family.length === 1 ? family[0] : `${family.slice(0, -1).join(', ')} and ${family.at(-1)}`} know your home is too ${chill ? 'cold' : 'hot'} today.` : '';
          said.push(
            risk
              ? risk.line + telling
              : chill
                ? chill.line + telling
              : a.heating === 'working'
                ? 'Good. I will take it that indoors is the warm place for you.'
                : a.heating === 'space_heater'
                  ? `Noted. In the cold I will remind you how to use it safely.${indoorCold.SPACE_HEATER}`
                  : a.heating
                    ? 'Noted. On a cold night I will not tell you to stay in without saying where else to go.' + (a.heating === 'cost' ? billHelp(p.country, 'heating') : '')
              : a.cooling === 'working'
                ? 'Good. I will take it that indoors is the cool place for you.'
                : a.cooling
                  ? 'Noted. On a hot day I will not tell you to stay in without saying where else to go.' + ROUTINE
                  : typeof a.topFloor === 'boolean'
                    ? (a.topFloor ? 'Noted. The top floor is the hottest part of a building, so on a hot day without cooling I will say so.' : 'Noted.')
                  : `Noted, ${Math.round(a.indoorTempF!)} degrees indoors. That is all right for now.`,
          );
          did.push({ tool: 'home', cooling: p.cooling ?? null, heating: p.heating ?? null, ...(risk ? { indoor: risk.level, basis: risk.basis } : {}), ...(chill ? { indoorCold: chill.level, basis: chill.basis } : {}), ...(risk?.control ? { homeControl: risk.control } : {}) });
        }
        // Age, and a plain no to the medicines or conditions question. See setup.ts.
        // Sudor is for adults, and Amazon's policy forbids collecting children's information, so an age under 18 is
        // not kept. A young child in the home is still a condition they can add for themselves.
        if (typeof a.age === 'number' && a.age < 18) {
          said.push("Sudor is made for adults, so I won't keep an age under 18. A grown-up can set it up for themselves.");
          did.push({ tool: 'home', age: null, kept: false });
        }
        else if (typeof a.age === 'number') {
          store.update(personOf(), (p) => void (p.age = a.age));
          if (a.age >= 65 && !store.get(personOf()).conditions.includes('older_adult')) await step('health_condition', { action: 'add', condition: 'over 65' });
          else { said.push('Noted.'); did.push({ tool: 'home', age: a.age }); }
        }
        if (a.noMedicines || a.noConditions) {
          store.update(personOf(), (p) => { if (a.noMedicines) p.noMedicines = true; if (a.noConditions) p.noConditions = true; });
          said.push('Noted. If that changes, just tell me.');
          did.push({ tool: 'home', noMedicines: !!a.noMedicines, noConditions: !!a.noConditions });
        }
        if (typeof a.checkInBy === 'number') {
          store.update(personOf(), (p) => void (p.checkInHour = a.checkInBy));
          const at = a.checkInBy === 12 ? 'noon' : a.checkInBy < 12 ? `${a.checkInBy} in the morning` : a.checkInBy >= 17 ? `${a.checkInBy - 12} in the evening` : `${a.checkInBy - 12} in the afternoon`;
          said.push(`Noted. On a dangerous day, if I have not heard from you by ${at}, the people who agreed will be asked to check on you.`);
          did.push({ tool: 'home', checkInHour: a.checkInBy });
        }
        if (typeof a.livesAlone === 'boolean') {
          store.update(personOf(), (p) => void (p.livesAlone = a.livesAlone));
          const family = store.get(personOf()).contacts.filter(reachable).map((c) => c.name);
          said.push(
            !a.livesAlone
              ? 'Noted.'
              : family.length
                ? `Noted. On a dangerous heat day, if I have not heard from you by two in the afternoon, I will ask ${family.join(' and ')} to check on you. Talking to me at all counts.`
                : 'Noted. Add somebody who can check on you, and on a dangerous heat day I will ask them to if I have not heard from you by two in the afternoon.',
          );
          did.push({ tool: 'home', livesAlone: a.livesAlone });
        }
        if (typeof a.privacy === 'boolean') await step('set_privacy', { on: a.privacy });
        if (!did.length) return call('my_profile', { action: 'show' });
        const added = !!a.place || !!a.medicines?.length || !!a.conditions?.length;
        /*
         * The first time a health detail is kept, they are told once what it is for and that it is not medical
         * advice. They agreed on the linking page; this says it again by voice, where they are, in two sentences.
         * Amazon: sensitive information needs a clear purpose and consent, and medical information carries this
         * disclaimer. https://developer.amazon.com/en-US/docs/alexa/alexaplus/add-ons/policy-requirements.html
         */
        const firstHealth = did.findIndex((d) => (d.tool === 'medication' && d.recognized === true) || d.tool === 'health_condition' || (d.tool === 'equipment' && d.recognized === true) || (d.tool === 'home' && typeof d.age === 'number'));
        if (firstHealth >= 0 && !store.get(personOf()).healthConsentAt) {
          store.update(personOf(), (p) => void (p.healthConsentAt = new Date().toISOString()));
          did[firstHealth].disclosed = true;
        }
        /*
         * Saving details is confirmed in one sentence: "Got it: Phoenix, furosemide and metoprolol, heart disease."
         * Each medicine and condition used to be read back with its own advice, 81 words for one sentence of
         * details. The advice is said when it matters, in the answer about the weather. Anything that needs the
         * person's attention, a name read as something else, a medicine not recognised, a question, is still said.
         */
        const plainAdds: string[] = [];
        const readAs: string[] = [];
        const keep: string[] = [];
        did.forEach((d, k) => {
          const text = said[k] ?? '';
          const simpleMed = d.tool === 'medication' && d.recognized === true && /^Added /.test(text);
          const simpleCondition = d.tool === 'health_condition' && /^Added /.test(text);
          const locating = d.tool === 'register_location' && d.status === 'locating';
          if (simpleMed) {
            plainAdds.push(String(d.generic ?? ''));
            // A brand is still said back as what it was read as, so a wrong reading is heard.
            const brand = /which is what (.+?) is\b/.exec(text)?.[1];
            if (brand) readAs.push(`${brand} is ${String(d.generic)}`);
          }
          else if (simpleCondition) plainAdds.push(String((d as { label?: string }).label ?? text.replace(/^Added ([^.]+)\..*$/, '$1')));
          else if (locating) plainAdds.unshift(String(d.place ?? ''));
          else keep.push(text);
        });
        const rewritten = plainAdds.filter(Boolean).length >= 2;
        if (rewritten) {
          said.length = 0;
          said.push(`Got it: ${andWords(plainAdds.filter(Boolean))}.${readAs.length ? ` ${andWords(readAs)}.` : ''} I'll use them in every answer.`, ...keep);
        }
        // The purpose line goes right after what was kept, before any question, so the question is still said last.
        const disclosedAt = did.findIndex((d) => d.disclosed);
        if (disclosedAt >= 0) { const at = rewritten ? 0 : disclosedAt; said[at] = `${said[at] ?? ''} ${HEALTH_PURPOSE}`.trim(); }
        // Several things at once repeat the same closing sentence, once each. It is said once, at the end.
        const sentencesSaid = said.filter(Boolean).flatMap((t) => sentences(t));
        const once = sentencesSaid.filter((x, i) => sentencesSaid.lastIndexOf(x) === i);
        // While the town is still being looked up there is no weather to ask about yet, so nothing is pointed at.
        let locating = did.some((d) => d.status === 'locating');
        /*
         * "I live in Sun City West, Arizona" was answered "Looking up Sun City West now. Ask me about the heat in a moment",
         * with nothing about the weather, and somebody trying it read that as the add-on doing nothing. The lookup and the
         * first forecast usually land in a second or two, so the answer waits a little for them and then says what it is
         * like there now. When they are slower than that, it is said the old way and the background carries on.
         */
        if (locating) {
          await settle(personOf(), 3500);
          const me = store.get(personOf());
          const snap = me.lat != null && me.lon != null && me.locationStatus === 'ready' ? weather.current(me.lat, me.lon) : null;
          if (snap && Number.isFinite(snap.tempF)) {
            const feels = Math.round(judgeHour(nowHour(snap), profileFor(me)).feelsF);
            const lookingAt = once.findIndex((x) => /^Looking up .* now.$/.test(x));
            if (lookingAt >= 0) once[lookingAt] = `Got it: ${me.locationName}.`;
            const askAt = once.findIndex((x) => /^Ask me about the heat in a moment.$/.test(x));
            if (askAt >= 0) once.splice(askAt, 1);
            once.push(`It feels like ${feels} degrees there right now. Ask me whether it's safe for you to go out.`);
            locating = false;
          } else if (me.locationStatus === 'not_found') {
            const lookingAt = once.findIndex((x) => /^Looking up .* now.$/.test(x));
            if (lookingAt >= 0) once[lookingAt] = `I couldn't find ${me.locationName}. Tell me the city and the state, or the city and the country, or a US zip code.`;
            const askAt = once.findIndex((x) => /^Ask me about the heat in a moment.$/.test(x));
            if (askAt >= 0) once.splice(askAt, 1);
            // Still no place, so the weather is not the next step: locating stays set and nothing is pointed at.
          }
        }
        // A place change waiting on a yes: that yes is the next step, not the weather.
        const asking = did.find((d) => d.status === 'confirm') as { nextAction?: unknown } | undefined;
        if (asking?.nextAction) return say(once.join(' '), { did, nextAction: asking.nextAction });
        if (goSomewhere) return say(once.join(' '), { did, fullAnswer: true, nextAction: { tool: 'somewhere_to_go', arguments: {} } });
        // Dementia takes away the person's own warning, and the study behind it recommends alerts that reach a carer.
        // With nobody on the list yet, adding somebody comes before the weather. See conditions.ts.
        const meNow = store.get(personOf());
        if (meNow.conditions.includes('dementia') && !meNow.contacts.length && a.conditions?.length && !locating) {
          const ask = 'Is there somebody who could check on you on hot days? Tell me their name and I will ask them.';
          return say([...once, ask].join(' '), { did, offer: ask, nextAction: { tool: 'contact', arguments: { action: 'add' } } });
        }
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
