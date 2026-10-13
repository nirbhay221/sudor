/**
 * One request, several steps.
 *
 * Each tool here answers one question well. A bad day is not one question. "Is it safe to go out" on a day when
 * it is not leads to "then when", which on a day with no good hour leads to "then where can I go", which leads to
 * "tell my daughter". Every one of those was already a tool, and each answer named at most the one after it, so
 * the chain depended on the host guessing the rest.
 *
 * So every answer now carries the chain it is on: what has just been done, the step that follows, and the steps
 * after that. A host can run them in order from one request, or offer them one at a time, and a screen can show
 * how far along it is. Nothing is called from here: this only says what comes next, and the tools still decide,
 * each from the person's own state, whether their step applies.
 *
 * What was just done is kept for a quarter of an hour, in memory, as tool names only: no arguments, no answers.
 */

type Next = { tool: string; arguments: Record<string, unknown> } | null;
export type Flow = {
  /** What this conversation is working through, in words a person would use. */
  about: string;
  /** Tools already answered in the last few minutes, oldest first, this one included. */
  done: string[];
  /** The step after this one, or null at the end of the chain. */
  next: string | null;
  /** What usually follows that, in order. */
  then: string[];
};

const WINDOW_MS = 15 * 60_000;
const MAX_HELD = 5000;
const trails = new Map<string, { tool: string; at: number }[]>();

/** What usually follows what, when the answer itself does not say. The dangerous day, and the day the power is out. */
const USUALLY: Record<string, string> = {
  about_me: 'weather_check',
  register_location: 'weather_check',
  medication: 'weather_check',
  health_condition: 'weather_check',
  weather_check: 'plan_my_day',
  plan_my_day: 'going_out_now',
  going_out_now: 'warning_signs',
  storm_prep: 'somewhere_to_go',
  somewhere_to_go: 'get_help',
};

const ABOUT: Record<string, string> = {
  about_me: 'setting up, then today',
  register_location: 'setting up, then today',
  medication: 'setting up, then today',
  health_condition: 'setting up, then today',
  weather_check: 'a day that is not safe outside',
  plan_my_day: 'a day that is not safe outside',
  going_out_now: 'going out anyway',
  storm_prep: 'the power, and somewhere to go',
  somewhere_to_go: 'somewhere to go, and who to tell',
  get_help: 'getting help',
};

export function record(id: string, tool: string, now = Date.now()): string[] {
  const kept = (trails.get(id) ?? []).filter((t) => now - t.at <= WINDOW_MS && t.tool !== tool);
  kept.push({ tool, at: now });
  trails.delete(id);
  trails.set(id, kept.slice(-8));
  if (trails.size > MAX_HELD) trails.delete(trails.keys().next().value as string);
  return kept.map((t) => t.tool);
}

export const trail = (id: string, now = Date.now()): string[] => (trails.get(id) ?? []).filter((t) => now - t.at <= WINDOW_MS).map((t) => t.tool);

/**
 * The chain an answer is on. `next` is what the answer itself named; when it named nothing, nothing is invented:
 * the chain ends there, which is how "it is a fine day to be out" stays one answer and not the start of four.
 */
export function describe(id: string, tool: string, next: Next): Flow | null {
  const done = record(id, tool);
  if (!next && done.length < 2) return null;
  const then: string[] = [];
  let at = next?.tool ?? null;
  const seen = new Set<string>([tool, ...(at ? [at] : [])]);
  while (at && then.length < 3) {
    const after = USUALLY[at];
    if (!after || seen.has(after)) break;
    then.push(after);
    seen.add(after);
    at = after;
  }
  return { about: ABOUT[tool] ?? 'this conversation', done, next: next?.tool ?? null, then };
}

export function resetForTest(): void {
  trails.clear();
}
