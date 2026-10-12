/**
 * "I feel dizzy." What to do, from the people whose job it is to say.
 *
 * The wording follows the National Weather Service heat illness guidance and
 * CDC's first aid for heat illness. The one line that matters most is the
 * split: heat stroke is an emergency and means calling 911 and giving nothing
 * to drink, while heat exhaustion means cooling down, sipping water, and
 * getting help if it lasts past an hour or the person vomits.
 *
 * This leans towards the emergency on purpose. Fainting shows up in both
 * lists, and it is treated as heat stroke here, because the cost of being
 * wrong in that direction is a call that was not needed.
 *
 * It is not a diagnosis. Alexa+ has its own emergency features, and nothing
 * here stands in for them.
 */

import type { Profile } from './personal.js';

export type Source = { name: string; url: string };
export type Triage = {
  level: 'emergency' | 'urgent' | 'self_care' | 'cramps' | 'info';
  matched: string[];
  spoken: string;
  sources: Source[];
};

const NWS = { name: 'National Weather Service, Heat Illness', url: 'https://www.weather.gov/safety/heat-illness' };
// "Do NOT give the person medicines used to treat fever (such as aspirin or acetaminophen). They will not
// help, and they may be harmful." A body overheated from outside is not a fever, and these act on fever.
const MEDLINE = { name: 'MedlinePlus, Heat emergencies', url: 'https://medlineplus.gov/ency/article/000056.htm' };
const NIOSH = { name: 'CDC NIOSH, Heat-related Illnesses and First Aid', url: 'https://www.cdc.gov/niosh/heat-stress/about/illnesses.html' };

const STROKE_SIGNS: [RegExp, string][] = [
  [/confus|disorient|not making sense|altered/, 'confusion'],
  [/slur/, 'slurred speech'],
  [/faint|passed out|passing out|black(ed)? out|unconscious|unresponsive|collapse/, 'fainting or collapse'],
  [/seizure|convuls/, 'a seizure'],
  [/hot,? (and )?dry skin|stopped sweating|not sweating|no sweat/, 'hot skin without sweating'],
];

/**
 * A body temperature of 103 or more, as opposed to any number in that range.
 *
 * This used to be a bare match on 103 to 119, anywhere in the sentence. In the places this add-on is for,
 * that is the weather: "it's 108 out and I feel weak" was read as a fever, answered with "call 911", and
 * emailed to the family as a heat stroke. A number only counts when the words say it is the person's own
 * temperature, and never when the same clause is about outside, the forecast or the heat index.
 */
const FEVER = /(?:\b(?:my|his|her|their|your|body|a) (?:temperature|temp)\b|\bfever\b|\bthermometer\b|\brunning a temp)[^.;!?]{0,40}?\b(?:10[3-9]|11\d)\b|\b(?:10[3-9]|11\d)\b(?: degree)?s? (?:fever|temperature)\b/;
const WEATHER_WORDS = /\b(outside|out there|outdoors|heat index|forecast|weather|in the shade|in the sun|today's high)\b/;

function fever(text: string): boolean {
  return text.split(/[.;!?]/).some((clause) => FEVER.test(clause) && !WEATHER_WORDS.test(clause));
}

/**
 * Whether a sign is described, as opposed to ruled out.
 *
 * "I'm not confused" and "no fainting" used to match exactly like "confused" and "fainting": the answer was
 * call 911, and the emergency contacts were emailed. A sign now counts only when the two or three words
 * before it do not take it back. Deliberately narrow, so that "I'm not confused but I've stopped sweating"
 * still counts the second half: missing a real emergency is the worse mistake.
 */
const TAKEN_BACK = /(?:\bno|\bnot|\bnever|\bwithout|n't|\bnor|\bisnt|\bwasnt|\bhavent|\bhasnt|\bdidnt|\bdoesnt|\bdont)\s+(?:[\w']+\s+){0,2}$/;

export function described(text: string, sign: RegExp): boolean {
  const all = new RegExp(sign.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = all.exec(text))) {
    if (!TAKEN_BACK.test(text.slice(Math.max(0, m.index - 40), m.index))) return true;
    if (m.index === all.lastIndex) all.lastIndex += 1;
  }
  return false;
}
/**
 * Whether somebody is asking about the signs, and not describing a person who has them.
 *
 * "Is confusion a sign of heat stroke?" names a heat stroke sign and used to be answered as an emergency,
 * which emailed the family that signs of heat stroke had been described. Nobody had described anything.
 *
 * The test is deliberately narrow, because the opposite mistake is the worse one. It is a general question
 * only when it opens like one, is about signs, symptoms or what something means, and says nothing about a
 * person: no he, she, I, my mother, no "right now". "Is she having heat stroke, she is confused" is not a
 * general question and is still an emergency. And even a general question is still answered with the 911
 * advice, said as "if that is happening now". Only the email is held back.
 */
const OPENS_AS_QUESTION = /^(what|which|how|is|are|can|could|does|do|should|would|tell me|explain|when)\b/;
const ABOUT_SIGNS = /\b(signs?|symptoms?|mean|means|look like|looks like|warning|how do (i|you) (know|tell)|what happens|difference)\b/;
const ABOUT_A_PERSON = /\b(he|she|they|i|i'm|im|we|him|her|them|my|mine|our|someone|somebody|husband|wife|mother|mom|mum|father|dad|son|daughter|child|kid|baby|friend|neighbou?r|patient|worker|man|woman|person)\b|right now|just now|at the moment/;

export function asksInGeneral(description: string): boolean {
  const text = description.toLowerCase().trim();
  // "How do I know" is about knowing, not about me.
  const rest = text.replace(/how (do|can|would) (i|we) (know|tell)/g, ' ');
  return OPENS_AS_QUESTION.test(text) && ABOUT_SIGNS.test(text) && !ABOUT_A_PERSON.test(rest);
}

const EXHAUSTION_SIGNS: [RegExp, string][] = [
  [/sweat(ing)? (a lot|heavily)|heavy sweat|drenched/, 'heavy sweating'],
  [/dizz|lightheaded|light headed/, 'dizziness'],
  [/nause|sick to/, 'nausea'],
  [/weak|tired|exhaust|fatigue/, 'weakness'],
  [/headache/, 'a headache'],
  [/clammy|pale/, 'cool, clammy skin'],
  [/fast pulse|racing heart|heart racing/, 'a fast pulse'],
];
const VOMIT = /vomit|throw(ing)? up|threw up|being sick/;
const CRAMPS = /cramp|spasm/;

export function triage(description: string, p?: Profile, lastedMinutes?: number): Triage {
  const text = description.toLowerCase();
  const stroke = STROKE_SIGNS.filter(([re]) => described(text, re)).map(([, s]) => s);
  if (fever(text)) stroke.push('a temperature above 103');
  const exhaustion = EXHAUSTION_SIGNS.filter(([re]) => described(text, re)).map(([, s]) => s);
  const vomiting = described(text, VOMIT);
  const cramps = described(text, CRAMPS);
  const sources = [NWS, NIOSH];

  if (stroke.length) {
    return {
      level: 'emergency',
      matched: stroke,
      spoken:
        'That can be heat stroke, which is an emergency. Call 911 now. While you wait, move them somewhere cool ' +
        'and cool them with cool wet cloths or a cool bath. Give them nothing to drink and no fever medicine.',
      sources: [...sources, MEDLINE],
    };
  }

  const cool = p?.noIce ? 'cool, not icy, wet cloths' : 'cool wet cloths or a cool bath';
  const fasting = !!p?.conditions.some((c) => c.id === 'fasting');
  const sip = p?.fluidLimit ? 'sip water within your fluid plan' : fasting ? 'break your fast and sip water' : 'sip water';

  if (vomiting || (exhaustion.length && lastedMinutes != null && lastedMinutes > 60)) {
    return {
      level: 'urgent',
      matched: [...exhaustion, ...(vomiting ? ['vomiting'] : [])],
      spoken:
        `Get medical help now. With heat exhaustion, ${vomiting ? 'vomiting' : 'symptoms lasting more than an hour'} ` +
        `means it needs a doctor. Meanwhile move somewhere cool, loosen clothing and use ${cool}.`,
      sources,
    };
  }

  if (exhaustion.length) {
    const ms = !p?.private && p?.conditions.some((c) => c.id === 'multiple_sclerosis')
      ? ' With MS, heat can bring symptoms back for a while; they usually settle within a day of cooling, but a new one that does not settle needs your doctor.'
      : '';
    return {
      level: 'self_care',
      matched: exhaustion,
      spoken:
        `That sounds like heat exhaustion. Move somewhere cooler, ideally air conditioned, loosen clothing, use ${cool}, ` +
        `and ${sip}. Aspirin, acetaminophen and ibuprofen will not bring it down, so do not take them for this. Get medical help if they vomit, it gets worse, or it lasts longer than an hour.${ms}`,
      sources,
    };
  }

  if (cramps) {
    const heart = !p?.private && p?.conditions.some((c) => c.id === 'heart_disease')
      ? ' With heart disease, get medical help sooner rather than waiting.'
      : '';
    return {
      level: 'cramps',
      matched: ['cramps'],
      spoken:
        'For heat cramps, press firmly on the cramping muscle or massage it gently, and sip water unless you feel sick. ' +
        `Get medical help if the cramps last longer than an hour.${heart}`,
      sources,
    };
  }

  return {
    level: 'info',
    matched: [],
    spoken:
      'Heat stroke signs are confusion, slurred speech, hot skin, fainting, or a temperature above 103. That is an ' +
      'emergency: call 911 and give nothing to drink. Heat exhaustion signs are heavy sweating, dizziness, nausea, ' +
      `weakness and a headache: cool down, ${sip}, and get help if it lasts over an hour or they vomit.`,
    sources,
  };
}
