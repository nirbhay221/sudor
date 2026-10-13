/**
 * Saying less, and keeping the rest for when it is asked for.
 *
 * Measured against live data, "is it safe for me outside" was answered in 85 words and seven sentences, and
 * "I have to go out now" in 113. Every sentence was true and most were useful, which is how they got that
 * long. But a voice answer is not a page. The listener cannot skim it, cannot look back, and has usually
 * stopped listening by the third sentence. Alexa+'s own design guidance says the add-on shapes the reply
 * through the data it returns rather than by scripting the voice, and research on voice interfaces keeps
 * finding the same thing: short, segmented replies are followed better than one dense one, most of all by
 * older listeners, who are the people this add-on is for.
 *
 * So one rule is applied in one place, to every read-only answer. The spoken part is the first three
 * sentences: the verdict, the reason and the next thing that matters. Everything after that is still
 * returned, as `more` in the structured result where a screen or the host can use it, and is spoken when
 * the customer asks for more. Nothing is thrown away and no tool had to learn to be brief on its own.
 *
 * Four things are never shortened: an answer that mentions 911, an error, a checklist a tool marks to be heard
 * whole, and a tool that already reads
 * its own steps a few at a time.
 */

const MAX_SENTENCES = 3;
const MAX_WORDS = 70;
const KEEP_MS = 10 * 60 * 1000;
const MAX_HELD = 5000;

type Result = {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Sentences, without breaking at "St. Mary's" or "Kp 2.0". */
export function sentences(text: string): string[] {
  const out: string[] = [];
  let rest = text.trim();
  const boundary = /([.!?]["')\]]?)\s+(?=[A-Z"'(])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(rest))) {
    const end = m.index + m[1].length;
    const piece = rest.slice(last, end);
    // A short capitalised abbreviation before the stop is part of a name, not the end of a sentence.
    if (/\b(St|Mt|Dr|Mr|Mrs|Ms|Jr|Sr|No|Ft|vs)\.$/.test(piece)) continue;
    out.push(piece.trim());
    last = end;
  }
  rest = rest.slice(last).trim();
  if (rest) out.push(rest);
  return out;
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

const held = new Map<string, { rest: string[]; at: number }>();

function remember(id: string, rest: string[]): void {
  held.delete(id);
  if (rest.length) held.set(id, { rest, at: Date.now() });
  if (held.size > MAX_HELD) held.delete(held.keys().next().value as string);
}

/** The next few sentences of the last answer, or null when there is nothing waiting. */
export function more(id: string, now = Date.now()): { spoken: string; left: number } | null {
  const h = held.get(id);
  if (!h || now - h.at > KEEP_MS) {
    held.delete(id);
    return null;
  }
  const next = h.rest.slice(0, MAX_SENTENCES);
  const rest = h.rest.slice(MAX_SENTENCES);
  remember(id, rest);
  return { spoken: next.join(' '), left: rest.length };
}

const PROMPT = 'Ask for more and I will go on.';

/**
 * Shorten one tool result.
 *
 * `offer` is the next step a tool wants to put to the customer ("Want me to watch it and tell your crew when
 * it clears?"). When there is one it takes the place of the generic prompt, because one question at the end
 * of an answer is a conversation and two is a menu.
 */
export function shorten(result: Result, id: string, opts: { readOnly: boolean }): Result {
  const first = result?.content?.[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string' || result.isError) return result;
  const sc = result.structuredContent ?? {};
  const offer = typeof sc.offer === 'string' ? sc.offer : '';
  const full = first.text;
  const withOffer = (said: string) => (offer && !said.includes(offer) ? `${said} ${offer}` : said);
  const out = (spoken: string, extra: Record<string, unknown> = {}): Result => ({
    ...result,
    content: [{ type: 'text', text: spoken }, ...(result.content ?? []).slice(1)],
    structuredContent: { ...sc, spoken, ...extra },
  });

  const parts = sentences(full);
  const pagesItself = sc.nextStep !== undefined || sc.nextFrom !== undefined;
  const fits = parts.length <= (typeof sc.sayFirst === 'number' ? sc.sayFirst : MAX_SENTENCES) && words(full) <= MAX_WORDS;
  // A checklist that is the whole point of the answer (what to do before the power goes) says so itself.
  if (!opts.readOnly || pagesItself || fits || sc.fullAnswer === true || /\b911\b/.test(full)) {
    if (opts.readOnly) remember(id, []);
    return offer ? out(withOffer(full)) : result;
  }

  // A tool can ask for fewer: a heads-up says its headline and the one step that matters, and stops.
  let keep = typeof sc.sayFirst === 'number' && sc.sayFirst >= 1 ? Math.min(MAX_SENTENCES, sc.sayFirst) : MAX_SENTENCES;
  while (keep > 1 && words(parts.slice(0, keep).join(' ')) > MAX_WORDS) keep -= 1;
  // Some things cannot wait to be asked for: a storm about to arrive on a job just called clear, or which
  // field was assumed. A tool names those in `mustSay`, and they are spoken whatever else is held back.
  const must = (Array.isArray(sc.mustSay) ? (sc.mustSay as unknown[]) : []).filter((x): x is string => typeof x === 'string' && x.length > 0);
  const head = parts.slice(0, keep);
  // Sentence by sentence: a two-sentence warning whose first half is already in the head still needs its second
  // half ("Ask me what to do before it arrives"), which matching the whole line against the head used to drop.
  const extra = [...new Set(must.flatMap((m) => sentences(m)))].filter((m) => !head.some((s) => s.includes(m)));
  const said = [...head, ...extra].join(' ');
  const rest = parts.slice(keep).filter((s) => !extra.some((m) => m.includes(s) || s.includes(m)));
  remember(id, rest);
  return out(`${said} ${offer || (rest.length ? PROMPT : '')}`.trim(), { full, more: rest });
}

export function resetForTest(): void {
  held.clear();
}

/**
 * Which tools are published.
 *
 * Each add-on grew sideways: one question answered well, then every neighbouring question somebody could
 * think of. Alexa+'s guidance is that each tool is "one meaningful customer intent" and that overlapping
 * tools make the host call the wrong one, and the first live evaluation here showed exactly that. So the
 * default surface is the one story the add-on is for. The rest still exists and is tested, and is published
 * when the scope is set to "all".
 */
export function inScope(name: string, secondary: readonly string[], scope: string | undefined): boolean {
  if ((scope ?? 'core').toLowerCase() === 'all') return true;
  return !secondary.includes(name);
}
