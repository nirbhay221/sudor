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

type Rule = { when: RegExp; tool: string; args?: (said: string) => Record<string, unknown> };

const after = (said: string, re: RegExp): string | undefined => re.exec(said)?.[1]?.trim().replace(/[.?!]+$/, '') || undefined;

const RULES: Rule[] = [
  { when: /\b(i'?m|we'?re|i am|we are) (safe|ok|okay|fine|all right)\b|\btell .* (i'?m|i am) safe\b|\bwe made it\b/i, tool: 'get_help', args: (s) => ({ status: 'safe', what: s }) },
  { when: /\b(help me|need help|get help|call (my|for) |tell my (family|daughter|son|wife|husband) i need)\b/i, tool: 'get_help', args: (s) => ({ what: s }) },
  { when: /\b(confus|dizzy|faint|passed out|collapse|stopped sweating|not sweating|cramp|headache|nause|vomit|throwing up|seizure|slurr|feel (sick|weak|unwell|ill))/i, tool: 'warning_signs', args: (s) => ({ symptoms: s }) },
  { when: /\b(where (can|could|do) i go|cooling cent|warming cent|shelter|no (power|heat|air)|power (is )?(out|cut)|house is (freezing|boiling|too hot|too cold))\b/i, tool: 'somewhere_to_go' },
  { when: /\b(hurricane|tornado|flood|blizzard|winter storm|ice storm|wildfire|smoke|evacuat|storm|warning|tsunami|prepare|power cut)\b/i, tool: 'storm_prep' },
  { when: /\b(recall|recalled)\b/i, tool: 'about_me', args: () => ({ recalls: true }) },
  { when: /\b(air ?con\w*|a\/?c|cooling)\b.*\b(broken|not working|out|died|off)\b/i, tool: 'about_me', args: () => ({ cooling: 'broken' }) },
  { when: /\bonly (have )?a fan\b/i, tool: 'about_me', args: () => ({ cooling: 'fan' }) },
  { when: /\b(i live in|i'?m in|move to|my (home|place|location) is) ([A-Za-z .,'-]{3,60})/i, tool: 'about_me', args: (s) => ({ place: after(s, /\b(?:i live in|i'?m in|move to|my (?:home|place|location) is) ([A-Za-z .,'-]{3,60})/i) }) },
  { when: /\b(i take|i'?m (taking|on)|started taking) ([a-z][a-z -]{2,40})/i, tool: 'about_me', args: (s) => ({ medicines: [after(s, /\b(?:i take|i'?m (?:taking|on)|started taking) ([a-z][a-z -]{2,40})/i)].filter(Boolean) }) },
  { when: /\b(what do you know about me|my profile|forget (me|everything))\b/i, tool: 'about_me', args: (s) => (/forget/i.test(s) ? { forget: true } : {}) },
  { when: /\b(add|tell|email|notify) .*\b(daughter|son|wife|husband|mother|father|mom|dad|sister|brother|friend|neighbou?r|contact)\b/i, tool: 'contact', args: (s) => ({ action: 'add', name: after(s, /\b(?:daughter|son|wife|husband|mother|father|mom|dad|sister|brother|friend|neighbou?r)\s+([A-Z][a-z]+)/) ?? 'them' }) },
  { when: /\b(share my day|my crew|crew link|my code is)\b/i, tool: 'share_my_day', args: () => ({ action: 'invite' }) },
  { when: /\b(i went out|i was out|back from|i felt)\b/i, tool: 'log_outing', args: (s) => ({ felt: /\b(unwell|sick|bad|dizzy|awful|not good)\b/i.test(s) ? 'unwell' : 'fine', note: s }) },
  { when: /\b(going out (now|right now)|heading out|about to go out|before i go out)\b/i, tool: 'going_out_now' },
  { when: /\b(when|best time|plan|schedule|shift|walk|garden|run|tomorrow)\b/i, tool: 'plan_my_day', args: (s) => (/\btomorrow\b/i.test(s) ? { day: 'tomorrow' } : {}) },
  { when: /\b(tell me more|go on|what else|why)\b/i, tool: 'tell_me_more' },
  { when: /\b(what can you do|help$|how does this work)\b/i, tool: 'what_can_you_do' },
  { when: /\b(hot|heat|cold|weather|outside|safe|go(ing)? out|temperature|sun|uv|freez)\b/i, tool: 'weather_check' },
];

export function chooseByWords(utterance: string, tools: ToolDef[]): Chosen {
  const started = Date.now();
  const listed = new Set(tools.map((t) => t.name));
  for (const r of RULES) {
    if (!listed.has(r.tool) || !r.when.test(utterance)) continue;
    const args = Object.fromEntries(Object.entries(r.args?.(utterance) ?? {}).filter(([, v]) => v !== undefined));
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
