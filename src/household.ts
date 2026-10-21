/**
 * The people at home with the customer, judged beside them.
 *
 * Sudor was one person: where they are and what they take. One Echo sits in a kitchen and the whole house talks
 * to it, and the people heat is hardest on are often not the one asking: a baby, a parent of 82 on a water pill.
 * HeatWatch (University of Sydney) lets a user add profiles for family members for the same reason. Nobody here
 * is a second account. Each is kept on the customer's own record, judged with the same rules as the customer
 * (profileOf in personal.ts), and said as one line after the customer's own answer, most at risk first. With
 * nobody added, nothing in any answer changes.
 *
 * Children are kept as an age group and nothing else: no name, no age, no health details. Sudor is for adults,
 * and the policy forbids collecting children's information. The age group is enough, because what the CDC says
 * for a baby or a young child (shade, drinks, never the car) does not depend on who the child is.
 * https://www.cdc.gov/heat-health/risk-factors/infants-and-children.html
 */

import type { LocationSnapshot } from './weather.js';
import type * as store from './store.js';
import { findMedication } from './meds.js';
import { conditionById } from './conditions.js';
import { profileOf, judgeHour, planDay, spanLabel, type Profile, type Status, type Judged } from './personal.js';

export type AgeGroup = 'baby' | 'young_child' | 'child' | 'teen' | 'adult' | 'older_adult';
export type Member = {
  id: string;
  /** What the customer calls them: "Mum", "Raj". For a child, only "the baby", "your son" and the like. */
  called: string;
  group: AgeGroup;
  /** Adults only. */
  age?: number;
  /** Adults only: generic names of medicines Sudor knows for heat or cold, as spoken and as read. */
  medicines: { spoken: string; generic: string }[];
  /** Adults only: condition ids from conditions.ts. */
  conditions: string[];
  at: string;
};

export const MAX_MEMBERS = 10;
export const MINOR: AgeGroup[] = ['baby', 'young_child', 'child', 'teen'];
const GROUP_WORDS: Record<AgeGroup, string> = { baby: 'the baby', young_child: 'your young child', child: 'your child', teen: 'your teenager', adult: '', older_adult: '' };
const KIN = /\b(son|daughter|grandson|granddaughter|grandchild|grandkid|nephew|niece|baby|toddler|boy|girl|kid|child|twins?)\b/i;

export function groupOf(age: number | undefined, said: string | undefined, called: string): AgeGroup {
  if (said && ['baby', 'young_child', 'child', 'teen', 'adult', 'older_adult'].includes(said)) {
    if (typeof age !== 'number') return said as AgeGroup;
  }
  if (typeof age === 'number') return age < 1 ? 'baby' : age < 5 ? 'young_child' : age < 13 ? 'child' : age < 18 ? 'teen' : age >= 65 ? 'older_adult' : 'adult';
  if (/\b(baby|newborn|infant)\b/i.test(called)) return 'baby';
  if (/\b(toddler|little one)\b/i.test(called)) return 'young_child';
  if (/\b(grand(ma|pa|mother|father|mum|mom|dad)|nana|nani|dadi|granny|gran|grandparent)\b/i.test(called)) return 'older_adult';
  return (said as AgeGroup) || 'adult';
}

/** What a child is called here: the kind of relative, never a name. "My son Arjun" is "your son". */
export function childCalled(group: AgeGroup, called: string): string {
  if (group === 'baby') return 'the baby';
  const kin = KIN.exec(called)?.[1]?.toLowerCase();
  if (kin && !['baby', 'kid', 'child', 'boy', 'girl', 'toddler'].includes(kin)) return `your ${kin.replace(/s$/, '')}`;
  return GROUP_WORDS[group];
}

/** Their medicines and conditions as a profile, the same one the customer is judged with. */
export function memberProfile(m: Member, isPrivate: boolean): Profile {
  const mechanisms = m.medicines.flatMap((x) => findMedication(x.generic)?.mechanisms ?? []);
  const conditions = [...m.conditions];
  if (m.group === 'baby' || m.group === 'young_child') conditions.push('young_child');
  if (m.group === 'older_adult' && !conditions.includes('older_adult')) conditions.push('older_adult');
  return profileOf([...new Set(mechanisms)], [...new Set(conditions)], { private: isPrivate });
}

const RANK: Record<Status, number> = { good: 0, caution: 1, avoid: 2 };
const SMALL = (m: Member) => m.group === 'baby' || m.group === 'young_child';

/**
 * One phrase per group of people with the same verdict, most at risk first, joined into one line:
 * "At home: Mum should stay in now. The baby can go out briefly, in the shade, and never left in the car. Raj is fine."
 */
function join(parts: { who: string[]; text: string; rank: number }[]): string {
  const sorted = [...parts].sort((a, b) => b.rank - a.rank);
  const named = (who: string[]) => {
    const w = who.map((x, i) => (i === 0 ? x.charAt(0).toUpperCase() + x.slice(1) : x));
    return w.length <= 1 ? w.join('') : `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}`;
  };
  return `At home: ${sorted.map((p) => `${named(p.who)} ${p.text.replace('{is}', p.who.length > 1 ? 'are' : 'is')}`).join('. ')}.`;
}

function groupBy<T>(xs: T[], key: (x: T) => string): T[][] {
  const out = new Map<string, T[]>();
  for (const x of xs) out.set(key(x), [...(out.get(key(x)) ?? []), x]);
  return [...out.values()];
}

export type FamilyLine = { line: string; members: { called: string; group: AgeGroup; status: Status }[] };

/** The household, right now. */
export function familyNow(household: Member[], snap: LocationSnapshot, hour: Parameters<typeof judgeHour>[0], isPrivate: boolean): FamilyLine | null {
  if (!household.length || !Number.isFinite(snap.tempF)) return null;
  const judged = household.map((m) => ({ m, j: judgeHour(hour, memberProfile(m, isPrivate)) }));
  const cold = judged[0].j.feelsF <= 50;
  const parts = groupBy(judged, (x) => `${x.j.status}:${SMALL(x.m)}`).map((g) => {
    const { status } = g[0].j;
    const small = SMALL(g[0].m);
    const text =
      status === 'avoid'
        ? `should stay in now: it's too ${cold ? 'cold' : 'hot'}${small ? (cold ? ', and small children lose heat fast' : ' for small children, and never leave them in a parked car') : ''}`
        : status === 'caution'
          ? cold
            ? `can go out, wrapped up warm, for a short time${small ? ', with a hat and an extra layer' : ''}`
            : `can go out for a short time, in the shade, with water${small ? ', and never left in a parked car' : ''}`
          : `{is} fine to go out${small && !cold ? ', with drinks, and never left in a parked car' : ''}`;
    return { who: g.map((x) => x.m.called), text, rank: RANK[status] * 2 + (small ? 1 : 0) };
  });
  return { line: join(parts), members: judged.map((x) => ({ called: x.m.called, group: x.m.group, status: x.j.status })) };
}

const hourOf = (local: string) => Number(local.slice(11, 13));
function spanOf(hours: Judged[], status: Status): string | null {
  const hit = hours.filter((h) => h.status === status);
  if (!hit.length) return null;
  return spanLabel(hit[0].local, hourOf(hit[hit.length - 1].local) - hourOf(hit[0].local) + 1);
}

/** The household, over today or tomorrow: the hours each of them should stay in. */
export function familyDay(household: Member[], snap: LocationSnapshot, day: 'today' | 'tomorrow', now: Date, isPrivate: boolean): FamilyLine | null {
  if (!household.length) return null;
  const judged = household.map((m) => {
    const plan = planDay(snap, memberProfile(m, isPrivate), { now, day });
    const status: Status = plan.hours.reduce<Status>((w, h) => (RANK[h.status] > RANK[w] ? h.status : w), 'good');
    return { m, status, stay: spanOf(plan.hours, 'avoid'), care: spanOf(plan.hours, 'caution') };
  });
  const parts = groupBy(judged, (x) => `${x.status}:${x.stay ?? x.care ?? ''}:${SMALL(x.m)}`).map((g) => {
    const { status, stay, care } = g[0];
    const small = SMALL(g[0].m);
    const text =
      status === 'avoid'
        ? `should stay in ${stay}${small ? ', and never be left in a parked car' : ''}`
        : status === 'caution'
          ? `can go out, but keep it short from ${care}${small ? ', with drinks and shade' : ''}`
          : `{is} fine all day${small ? ', with drinks and shade' : ''}`;
    return { who: g.map((x) => x.m.called), text, rank: RANK[status] * 2 + (small ? 1 : 0) };
  });
  return { line: join(parts), members: judged.map((x) => ({ called: x.m.called, group: x.m.group, status: x.status })) };
}

/** Find who they meant: "Mum", "my mum", "the kids", "Grandma", "everyone". */
export function whoIs(household: Member[], said: string[]): Member[] {
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/^(my|our|the|your)\s+/, '').trim();
  if (said.some((s) => /\b(everyone|everybody|whole family|all of us|the family|family)\b/i.test(s))) return household;
  const out = new Set<Member>();
  for (const s of said) {
    const f = fold(s);
    if (!f) continue;
    if (/\b(kids|children|little ones)\b/.test(f)) household.filter((m) => MINOR.includes(m.group)).forEach((m) => out.add(m));
    for (const m of household) {
      const c = fold(m.called);
      if (c === f || (f.length >= 3 && c.length >= 3 && (c.includes(f) || f.includes(c)))) out.add(m);
    }
  }
  return [...out];
}

/** A spoken list of what they take and have, for reading back. Nothing named in privacy mode. */
export function describeMember(m: Member, isPrivate: boolean): string {
  if (MINOR.includes(m.group)) return m.called;
  const bits: string[] = [];
  if (typeof m.age === 'number') bits.push(String(m.age));
  if (!isPrivate) {
    bits.push(...m.medicines.map((x) => x.generic));
    bits.push(...m.conditions.map((c) => conditionById(c)?.label ?? c.replace(/_/g, ' ')));
  } else if (m.medicines.length || m.conditions.length) bits.push('health details kept private');
  return bits.length ? `${m.called}, ${bits.join(', ')}` : m.called;
}

export const householdOf = (p: store.Person): Member[] => p.household ?? [];
