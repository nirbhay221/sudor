/**
 * The stand-in with no model behind it.
 *
 * The talking demo asks a language model to read this server's tool list and pick a tool, which is the
 * honest test of the tool descriptions. When no model is configured, or today's budget is spent, the page
 * still has to answer somebody who types or speaks a sentence. Recall Check, another entry in this
 * hackathon, does the same thing: plain word rules choose the tool. These are those rules for Sudor.
 *
 * Every answer chosen this way says so (`model: 'word rules'`), because a rule matching "dizzy" proves
 * nothing about whether a host would read the descriptions the same way. Only the tool and the plain
 * arguments that can be read straight off the sentence are filled in; anything else is left for the tool
 * to ask about.
 */

import type { Chosen, ToolDef } from './agent.js';
import { anyEmergency, triage } from './firstaid.js';

type Rule = { when: RegExp; tool: string; args?: (said: string) => Record<string, unknown> | null };

const after = (said: string, re: RegExp): string | undefined => re.exec(said)?.[1]?.trim().replace(/[.?!]+$/, '') || undefined;

/*
 * Found on 22 October 2026 by saying the demo's lines and what frightened people say, with no model running: "she's
 * not breathing", "he's having chest pain" and "she's seizing" got "I did not catch what you want", and so did the
 * demo's own "My air conditioner just stopped working", an email address, an age with living alone, and the week,
 * past heat, trip, doctor and household questions. Once the day's model budget is spent these rules are the demo.
 */
const NUM_WORDS: Record<string, number> = { sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ageIn = (s: string): number | undefined => {
  const n = /\b(?:i'?m|i am|aged?)\s+(\d{2,3})\b/i.exec(s)?.[1] ?? /\b(\d{2,3}) years? old\b/i.exec(s)?.[1];
  if (n) return Number(n);
  const w = /\b(?:i'?m|i am)\s+(sixty|seventy|eighty|ninety)\b/i.exec(s)?.[1]?.toLowerCase();
  return w ? NUM_WORDS[w] : undefined;
};

const RULES: Rule[] = [
  // An emergency first, whatever else the sentence says.
  { when: /./, tool: 'warning_signs', args: (s) => (anyEmergency(s).length || ['emergency', 'urgent'].includes(triage(s).level) ? { symptoms: s } : null) as Record<string, unknown> },
  { when: /\b(i'?m|we'?re|i am|we are) (safe|ok|okay|fine|all right)\b|\btell .* (i'?m|i am) safe\b|\bwe made it\b/i, tool: 'get_help', args: (s) => ({ status: 'safe', what: s }) },
  { when: /\b(help me|need help|get help|call (my|for) |tell my (family|daughter|son|wife|husband) i need)\b/i, tool: 'get_help', args: (s) => ({ what: s }) },
  { when: /\b(confus|dizzy|faint|passed out|collapse|stopped sweating|not sweating|cramp|headache|nause|vomit|throwing up|seizure|slurr|feel (a bit |really |very |so )?(sick|weak|unwell|ill|tired|exhausted|awful|terrible))/i, tool: 'warning_signs', args: (s) => ({ symptoms: s }) },
  { when: /\b(where (can|could|do) i go|cooling cent|warming cent|shelter|no (power|heat|air)|power (is )?(out|cut)|house is (freezing|boiling|too hot|too cold))\b/i, tool: 'somewhere_to_go' },
  { when: /\b(hurricane|tornado|flood|blizzard|winter storm|ice storm|wildfire|smoke|evacuat|storm|warning|tsunami|prepare|power cut)\b/i, tool: 'storm_prep' },
  { when: /\b(recall|recalled)\b/i, tool: 'about_me', args: () => ({ recalls: true }) },
  // Before "broken": "I keep the AC off because of the bill" is a working unit left off, not a broken one.
  { when: /\b(afford|bill|too (expensive|costly)|costs? too much)\b/i, tool: 'about_me', args: () => ({ cooling: 'cost' }) },
  { when: /\b(air ?con\w*|a\/?c|cooling)\b.*\b(broken|not working|stopped( working)?|quit|gave out|won'?t (turn on|work)|isn'?t working|out|died|off)\b/i, tool: 'about_me', args: () => ({ cooling: 'broken' }) },
  { when: /[\w.+-]+@[\w-]+\.[\w.]+/, tool: 'contact', args: (s) => ({ action: 'add', name: /^\s*(?:[Mm]y (?:daughter|son|wife|husband|mother|father|mom|mum|dad|sister|brother|friend|neighbou?r|carer|aide)\s+)?([A-Z][a-z]+)\b/.exec(s)?.[1] ?? 'them', email: /[\w.+-]+@[\w-]+\.[\w.]*[a-z]/i.exec(s)?.[0], relation: /\b(daughter|son|wife|husband|mother|father|mom|mum|dad|sister|brother|friend|neighbou?r|carer|aide)\b/i.exec(s)?.[1]?.toLowerCase() }) },
  { when: /\b(going to|trip to|travel(l?ing)? to|visiting|holiday in|vacation in)\s+[A-Z]/, tool: 'my_trips', args: (s) => ({ action: 'add', place: /\b(?:going to|trip to|travel(?:l?ing)? to|visiting|holiday in|vacation in)\s+([A-Z][\w .,'-]{2,60}?)(?=\s+(?:next|this|on|for|in|from|tomorrow)\b|[.?!]|$)/.exec(s)?.[1] }) },
  { when: /\b(next|this|coming) (week|few days|seven days)\b|\bweek ahead\b/i, tool: 'plan_my_week' },
  { when: /\b(how many|how often|last (week|month|year)|this (month|year)).*\b(hot|cold|heat|days)\b|\bheat (history|patterns)\b/i, tool: 'heat_patterns', args: (s) => ({ period: /\byear\b/i.test(s) ? 'year' : /\bweek\b/i.test(s) ? 'week' : 'month' }) },
  { when: /\b(my )?(doctor|pharmacist|nurse|gp) (told|said|says|wants|advised)\b/i, tool: 'doctor_plan', args: (s) => ({ action: 'add', says: s, when: /\bcold\b/i.test(s) ? 'cold_days' : /\bevery day|always\b/i.test(s) ? 'always' : 'hot_days' }) },
  { when: /\b(lives? with (me|us)|living with (me|us)|we have a (baby|toddler|newborn)|my (mum|mom|mother|dad|father|husband|wife|partner|son|daughter|baby|grandma|grandpa) (lives|is staying) with)\b/i, tool: 'household', args: (s) => ({ action: 'add', called: /\b(mum|mom|mother|dad|father|husband|wife|partner|son|daughter|baby|toddler|newborn|grandma|grandpa)\b/i.exec(s)?.[1], age: /\b(?:she'?s|he'?s|aged?|is)\s+(\d{1,3})\b/i.exec(s)?.[1] ? Number(/\b(?:she'?s|he'?s|aged?|is)\s+(\d{1,3})\b/i.exec(s)?.[1]) : undefined }) },
  { when: /\b(i live (alone|on my own|by myself))\b|\b(i'?m|i am) (\d{2,3}|sixty|seventy|eighty|ninety)\b/i, tool: 'about_me', args: (s) => ({ ...(ageIn(s) != null ? { age: ageIn(s) } : {}), ...(/\b(alone|on my own|by myself)\b/i.test(s) ? { livesAlone: true } : {}) }) },
  { when: /\b(ramadan|fasting|keeping the fast)\b/i, tool: 'about_me', args: () => ({ conditions: ['fasting'] }) },
  { when: /\bi have (?!to\b|got to\b|a question|no\b)([a-z' ]{3,40})[.?!]*$/i, tool: 'about_me', args: (s) => ({ conditions: [/\bi have ([a-z' ]{3,40})$/i.exec(s.replace(/[.?!]+$/, ''))?.[1]].filter(Boolean) }) },
  { when: /\bonly (have )?a fan\b/i, tool: 'about_me', args: () => ({ cooling: 'fan' }) },
  { when: /\b(i live in|i'?m in|move to|my (home|place|location) is) ([A-Za-z .,'-]{3,60})/i, tool: 'about_me', args: (s) => ({ place: after(s, /\b(?:i live in|i'?m in|move to|my (?:home|place|location) is) ([A-Za-z .,'-]{3,60})/i) }) },
  { when: /\b(i take|i'?m (taking|on)|started taking) ([a-z][a-z -]{2,40})/i, tool: 'about_me', args: (s) => ({ medicines: [after(s, /\b(?:i take|i'?m (?:taking|on)|started taking) ([a-z][a-z -]{2,40})/i)].filter(Boolean) }) },
  { when: /\b(what do you know about me|my profile|forget (me|everything))\b/i, tool: 'about_me', args: (s) => (/forget/i.test(s) ? { forget: true } : {}) },
  { when: /\b(add|tell|email|notify) .*\b(daughter|son|wife|husband|mother|father|mom|dad|sister|brother|friend|neighbou?r|contact)\b/i, tool: 'contact', args: (s) => ({ action: 'add', name: after(s, /\b(?:daughter|son|wife|husband|mother|father|mom|dad|sister|brother|friend|neighbou?r)\s+([A-Z][a-z]+)/) ?? 'them' }) },
  { when: /\b(share my day|my crew|crew link|my code is)\b/i, tool: 'share_my_day', args: () => ({ action: 'invite' }) },
  { when: /\b(i went out|i was out|back from|i felt)\b/i, tool: 'log_outing', args: (s) => ({ felt: /\b(unwell|sick|bad|dizzy|awful|not good)\b/i.test(s) ? 'unwell' : 'fine', note: s }) },
  { when: /\b(going out (now|right now)|heading out|about to go out|before i go out|(have|need|got) to go out|must go out)\b/i, tool: 'going_out_now' },
  { when: /\b(when|best time|plan|schedule|shift|walk|garden|run|tomorrow)\b/i, tool: 'plan_my_day', args: (s) => (/\btomorrow\b/i.test(s) ? { day: 'tomorrow' } : {}) },
  { when: /\b(tell me more|go on|what else|why)\b/i, tool: 'tell_me_more' },
  { when: /\b(what can you do|help$|how does this work)\b/i, tool: 'what_can_you_do' },
  { when: /\b(hot|heat|cold|weather|outside|safe|go(ing)? out|temperature|sun|uv|freez)\b/i, tool: 'weather_check' },
];

/*
 * A bare answer to the question just asked. Every setup question ends on a yes or no, and "no" on its own matches
 * no rule: it only means something against the question before it, which is how Alexa+ reads it. The page sends
 * the turns so far and the next step the last answer named; a yes takes that step, and the answers below are read
 * against the question's own words.
 */
const YES = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|please( do)?|go ahead|do it|i do|i have|that'?s right|correct)\b/i;
const NO = /^\s*(no|nope|nah|none|not really|i don'?t|i do not|never)\b/i;
const UNSURE = /\b(not sure|don'?t know|no idea|unsure|no clue)\b/i;
type Bare = { tool: string; args: Record<string, unknown> } | null;
const BARE: [RegExp, (said: string, question: string) => Bare][] = [
  [/Do you take any medicines\?$/, (s) => (NO.test(s) ? { tool: 'about_me', args: { noMedicines: true } } : null)],
  [/Do you have any health conditions\?$/, (s) => (NO.test(s) ? { tool: 'about_me', args: { noConditions: true } } : null)],
  [/Do you live on your own\?$/, (s) => (YES.test(s) ? { tool: 'about_me', args: { livesAlone: true } } : NO.test(s) ? { tool: 'about_me', args: { livesAlone: false } } : null)],
  [/Should I say the names\?$/, (s) => (YES.test(s) ? { tool: 'about_me', args: { privacy: false } } : NO.test(s) ? { tool: 'about_me', args: { privacy: true } } : null)],
  [/Is it working\?$/, (s) => (YES.test(s) ? { tool: 'about_me', args: { cooling: 'working' } } : NO.test(s) ? { tool: 'about_me', args: { cooling: 'broken' } } : null)],
  [/how old are you\?$/, (s) => { const n = Number(/\b(\d{1,3})\b/.exec(s)?.[1]); return n ? { tool: 'about_me', args: { age: n } } : null; }],
];

export function bareAnswer(utterance: string, history: { role: string; text: string }[] = [], next?: { tool?: unknown; arguments?: unknown } | null): Bare {
  const last = [...history].reverse().find((t) => t.role === 'assistant')?.text.trim() ?? '';
  if (!last) return null;
  for (const [asked, read] of BARE) if (asked.test(last)) { const hit = read(utterance, last); if (hit) return hit; }
  if (YES.test(utterance) && next && typeof next.tool === 'string') return { tool: next.tool, args: next.arguments && typeof next.arguments === 'object' ? (next.arguments as Record<string, unknown>) : {} };
  return null;
}

export function chooseByWords(utterance: string, tools: ToolDef[], history: { role: string; text: string }[] = [], next?: { tool?: unknown; arguments?: unknown } | null): Chosen {
  const bare = bareAnswer(utterance, history, next);
  if (bare && tools.some((t) => t.name === bare.tool)) return { tool: bare.tool, args: bare.args, said: '', ms: 0, model: 'word rules' } as Chosen;
  const started = Date.now();
  const listed = new Set(tools.map((t) => t.name));
  for (const r of RULES) {
    if (!listed.has(r.tool) || !r.when.test(utterance)) continue;
    // A rule whose arguments come back null does not apply after all: the next one is tried.
    const raw = r.args ? r.args(utterance) : {};
    if (raw === null) continue;
    const args = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
    return { tool: r.tool, args, said: '', ms: Date.now() - started, model: 'word rules' } as Chosen;
  }
  return {
    tool: null,
    args: {},
    said: 'I did not catch what you want. Try asking whether it is safe to go out, or say what you are feeling.',
    ms: Date.now() - started,
    model: 'word rules',
  } as Chosen;
}
