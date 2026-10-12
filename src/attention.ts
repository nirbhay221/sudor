/**
 * Noticing when an answer did not land, and saying the thing that matters until it is heard.
 *
 * Two findings from studies of older adults using voice assistants at home shaped this. People repeat a
 * question when the first answer did not land, and an assistant that answers the repeat with the same sixty
 * words has learned nothing from being asked twice. And a thing that matters is better said again, briefly,
 * until the person says they have it, than said once and assumed.
 *
 * So:
 *   - the same question from the same person inside a minute and a half, with the same answer, gets the
 *     verdict alone and an offer of what to ask next. Never for an answer that mentions 911, which is said in
 *     full every time it is asked;
 *   - a day that is a stay-inside day for this person is mentioned at the start of whatever they ask next,
 *     up to three times, until they say they have heard it.
 *
 * Both live in memory. A restart forgets a repeat in progress and nothing else, and the reminder is rebuilt
 * the next time the day is planned.
 */

import { sentences } from './brief.js';

type Result = { content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const REPEAT_MS = 90 * 1000;
const MAX_HELD = 5000;
const last = new Map<string, { key: string; text: string; at: number }>();

const textOf = (r: Result): string | null => (r?.content?.[0]?.type === 'text' && typeof r.content[0].text === 'string' ? r.content[0].text : null);

function withText(r: Result, spoken: string, extra: Record<string, unknown> = {}): Result {
  return { ...r, content: [{ type: 'text', text: spoken }, ...(r.content ?? []).slice(1)], structuredContent: { ...(r.structuredContent ?? {}), spoken, ...extra } };
}

/** The same question again, straight away: the verdict alone, and what to ask next. */
export function onRepeat(id: string, name: string, args: unknown, result: Result, readOnly: boolean, now = Date.now()): Result {
  const text = textOf(result);
  if (!text || result.isError || !readOnly) return result;
  const key = `${name}|${JSON.stringify(args ?? {})}`;
  const before = last.get(id);
  last.delete(id);
  last.set(id, { key, text, at: now });
  if (last.size > MAX_HELD) last.delete(last.keys().next().value as string);
  if (!before || before.key !== key || before.text !== text || now - before.at > REPEAT_MS) return result;
  // An emergency is said whole, however many times it is asked.
  if (/\b911\b/.test(text)) return result;
  const parts = sentences(text);
  if (parts.length < 2) return result;
  const short = `In short: ${parts[0]} Ask me why, or what to do about it.`;
  return withText(result, short, { repeated: true });
}

/* ---------------------------------------------------------------- the standing reminder */

const MAX_TIMES = 3;
const reminders = new Map<string, { date: string; said: number }>();

/** Note that this local date is a stay-inside day for this person. Called when a day is planned. */
export function remember(id: string, localDate: string): void {
  const held = reminders.get(id);
  if (held?.date === localDate) return;
  reminders.delete(id);
  reminders.set(id, { date: localDate, said: 0 });
  if (reminders.size > MAX_HELD) reminders.delete(reminders.keys().next().value as string);
}

/** They said they have it. Nothing more is said about today. */
export function heard(id: string): boolean {
  return reminders.delete(id);
}

/** The reminder to put in front of this answer, or an empty string. Counts itself. */
export function reminder(id: string, localDate: string | null, name: string): string {
  const held = reminders.get(id);
  if (!held) return '';
  if (!localDate || held.date !== localDate) {
    // Yesterday's warning is not today's.
    if (localDate) reminders.delete(id);
    return '';
  }
  // Not on the answer that set it, and not on an answer that is itself about the day.
  if (name === 'plan_my_day') return '';
  // Nor in front of an answer to "I feel dizzy" or "get help": the person asked something urgent, and that comes first.
  if (name === 'warning_signs' || name === 'get_help' || name === 'somewhere_to_go') return '';
  if (held.said >= MAX_TIMES) return '';
  held.said += 1;
  return held.said === 1
    ? 'Remember, today is a stay-inside day for you. Say got it and I will stop reminding you.'
    : 'Today is still a stay-inside day for you.';
}

export function resetForTest(): void {
  last.clear();
  reminders.clear();
}
