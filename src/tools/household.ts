/**
 * The people at home: one tool, added beside the rest.
 *
 * Telling Sudor about somebody else at home ("my mum lives with us, she's 82 and takes Lasix", "we have a baby")
 * keeps them on this customer's record. From then on the answers about going out, the day and a trip end with one
 * line about them. Nobody told about, nothing changes: the customer on their own is answered exactly as before.
 * See household.ts for who is kept and how.
 */

import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as store from '../store.js';
import { findMedication } from '../meds.js';
import { findCondition, conditionById } from '../conditions.js';
import { groupOf, childCalled, describeMember, whoIs, householdOf, MINOR, MAX_MEMBERS, type Member, type AgeGroup } from '../household.js';
import { say } from './shared.js';

const clean = (s: string, n: number) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const andList = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
/** "my mum" is kept as "Mum", the way it is said back: "Mum should stay in now". */
const tidy = (s: string) => {
  // "my husband Raj" is Raj: a name, when one is said, is what they are called.
  let t = clean(s, 40).replace(/^(my|our)\s+/i, '');
  const [kin, ...rest] = t.split(' ');
  if (rest.length === 1 && /^[A-Z][a-z]+$/.test(rest[0]) && /^(husband|wife|partner|mum|mom|dad|mother|father|grandma|grandpa|granny|aunt|uncle|brother|sister|flatmate|roommate|friend|carer|caregiver)$/i.test(kin)) t = rest[0];
  return /^(mum|mom|dad|mother|father|husband|wife|partner|grandma|grandpa|granny|gran|nana|nani|dadi|aunt|uncle|brother|sister)$/i.test(t) ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : t;
};
const PURPOSE = 'I keep what you tell me about the people at home only to warn you about the heat and the cold for them, and forget it when you say so.';

export function register(server: McpServer, personOf: () => string): void {
  server.registerTool(
    'household',
    {
      title: 'The people at home',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        'The other people who live with the customer, or are travelling with them: a partner, a parent, a baby, children. ' +
        'action add saves one person, or adds medicines or conditions to somebody already saved; list reads them back; ' +
        'remove takes one off; clear removes them all. Once somebody is saved, the answers about going out, the day and ' +
        'trips also say what the weather means for them. Call this when the customer talks about another person at home: ' +
        '"my mum lives with us and takes Lasix", "my husband has heart disease", "we have a baby", "my son is four". ' +
        'One call per person. Never for the customer themselves, whose own place, medicines and conditions are kept separately.',
      inputSchema: {
        action: z.enum(['add', 'list', 'remove', 'clear']).describe('add, list, remove or clear'),
        called: z.string().optional().describe('What the customer calls them, as said: "Mum", "my husband Raj", "the baby", "my son"'),
        age: z.number().int().min(0).max(120).optional().describe('Their age in years, when said: a baby under one is 0'),
        ageGroup: z.enum(['baby', 'young_child', 'child', 'teen', 'adult', 'older_adult']).optional().describe('When no age is said: baby, young_child (1 to 4), child (5 to 12), teen, adult, or older_adult (65 or over)'),
        medicines: z.array(z.string()).max(8).optional().describe('Medicines this person takes, as spoken. Adults only'),
        conditions: z.array(z.string()).max(8).optional().describe('Health conditions this person has, as said. Adults only'),
      },
    },
    async ({ action, called, age, ageGroup, medicines, conditions }) => {
      const id = personOf();
      const person = store.get(id);
      const home = householdOf(person);

      if (action === 'list') {
        if (!home.length) return say("You haven't told me about anybody else at home. Tell me who lives with you, like your mum and her medicines, or a baby.", { count: 0 });
        return say(`At home with you: ${home.map((m) => describeMember(m, person.privacy)).join('; ')}.`, { count: home.length, members: home.map((m) => ({ called: m.called, group: m.group })) });
      }
      if (action === 'clear') {
        if (!home.length) return say("You haven't told me about anybody else at home.", { cleared: 0 });
        store.update(id, (p) => void (p.household = []));
        return say(`Done. I've forgotten the ${home.length === 1 ? 'person' : `${home.length} people`} at home, and I'll answer just for you.`, { cleared: home.length });
      }

      const said = clean(called ?? '', 60);
      if (action === 'remove') {
        const target = whoIs(home, [said])[0];
        if (!target) return say(home.length ? `I don't have ${said || 'them'} at home. I have ${andList(home.map((m) => m.called))}.` : "You haven't told me about anybody else at home.", { removed: false });
        store.update(id, (p) => void (p.household = (p.household ?? []).filter((m) => m.id !== target.id)));
        return say(`Removed ${target.called}.`, { removed: true });
      }

      // add
      if (!said && typeof age !== 'number' && !ageGroup) return say('Who lives with you? Tell me what you call them, and their age or medicines if you like.', { saved: false, needs: 'called' });
      const group: AgeGroup = groupOf(age, ageGroup, said);
      const minor = MINOR.includes(group);
      const name = minor ? childCalled(group, said) : tidy(said || (group === 'older_adult' ? 'your older relative' : 'the other adult'));
      // Somebody already saved, told about again: "Mum also takes metoprolol". A child is never matched by a name.
      const existing = minor ? home.find((m) => m.called === name && m.group === group) : whoIs(home.filter((m) => !MINOR.includes(m.group)), [said || name])[0];
      if (!existing && home.length >= MAX_MEMBERS) return say(`I keep up to ${MAX_MEMBERS} people at home. Remove somebody first.`, { saved: false, reason: 'full' });

      const known: { spoken: string; generic: string }[] = [];
      const unknown: string[] = [];
      const found: string[] = [];
      const missed: string[] = [];
      if (!minor) {
        for (const spoken of (medicines ?? []).map((x) => clean(x, 60)).filter(Boolean)) {
          const med = findMedication(spoken);
          if (med) known.push({ spoken, generic: med.generic });
          else unknown.push(spoken);
        }
        for (const c of (conditions ?? []).map((x) => clean(x, 60)).filter(Boolean)) {
          const hit = findCondition(c);
          if (hit) found.push(hit.id);
          else missed.push(c);
        }
      }
      const member: Member = existing
        ? {
            ...existing,
            ...(minor ? {} : typeof age === 'number' ? { age, group } : {}),
            medicines: [...existing.medicines, ...known.filter((k) => !existing.medicines.some((x) => x.generic === k.generic))].slice(0, 12),
            conditions: [...new Set([...existing.conditions, ...found])].slice(0, 12),
          }
        : { id: randomBytes(4).toString('hex'), called: name, group, ...(minor || typeof age !== 'number' ? {} : { age }), medicines: known, conditions: [...new Set(found)], at: new Date().toISOString() };
      const firstHealth = !minor && (known.length > 0 || found.length > 0) && !home.some((m) => m.medicines.length || m.conditions.length);
      store.update(id, (p) => void (p.household = existing ? (p.household ?? []).map((m) => (m.id === existing.id ? member : m)) : [...(p.household ?? []), member]));

      const parts: string[] = [];
      const newly = [...known.map((k) => k.generic), ...found.map((c) => conditionById(c)?.label ?? c)];
      parts.push(existing ? `Updated ${member.called}${newly.length && !person.privacy ? `: ${andList(newly)}` : ''}.` : `Added ${describeMember(member, person.privacy)}, at home with you.`);
      if (minor && ((medicines?.length ?? 0) > 0 || (conditions?.length ?? 0) > 0 || typeof age === 'number')) {
        parts.push("For children I keep only the age group, not names, ages or health details. If a child's medicine or condition matters in the heat, ask their doctor.");
      }
      if (unknown.length) parts.push(`I don't know how ${andList(unknown)} ${unknown.length === 1 ? 'affects' : 'affect'} the heat, so I'll judge ${member.called} without ${unknown.length === 1 ? 'it' : 'them'}.`);
      if (missed.length) parts.push(`I don't know ${andList(missed)} as a condition.`);
      if (firstHealth) parts.push(PURPOSE);
      if (!existing) parts.push(`When you ask about the weather, your day or a trip, I'll say what it means for ${member.called} too.`);
      return say(parts.join(' '), {
        saved: true,
        member: { called: member.called, group: member.group, medicines: member.medicines.map((m) => m.generic), conditions: member.conditions },
        count: existing ? home.length : home.length + 1,
        nextAction: { tool: 'weather_check', arguments: {} },
      });
    },
  );
}
