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
const NIOSH = { name: 'CDC NIOSH, Heat-related Illnesses and First Aid', url: 'https://www.cdc.gov/niosh/heat-stress/about/illnesses.html' };

const STROKE_SIGNS: [RegExp, string][] = [
  [/confus|disorient|not making sense|altered/, 'confusion'],
  [/slur/, 'slurred speech'],
  [/faint|passed out|passing out|black(ed)? out|unconscious|unresponsive|collapse/, 'fainting or collapse'],
  [/seizure|convuls/, 'a seizure'],
  [/hot,? (and )?dry skin|stopped sweating|not sweating|no sweat/, 'hot skin without sweating'],
  [/\b10[3-9]\b|\b11\d\b/, 'a temperature above 103'],
];
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
  const stroke = STROKE_SIGNS.filter(([re]) => re.test(text)).map(([, s]) => s);
  const exhaustion = EXHAUSTION_SIGNS.filter(([re]) => re.test(text)).map(([, s]) => s);
  const vomiting = VOMIT.test(text);
  const cramps = CRAMPS.test(text);
  const sources = [NWS, NIOSH];

  if (stroke.length) {
    return {
      level: 'emergency',
      matched: stroke,
      spoken:
        'That can be heat stroke, which is an emergency. Call 911 now. While you wait, move them somewhere cool ' +
        'and cool them with cool wet cloths or a cool bath. Do not give them anything to drink.',
      sources,
    };
  }

  const cool = p?.noIce ? 'cool, not icy, wet cloths' : 'cool wet cloths or a cool bath';
  const sip = p?.fluidLimit ? 'sip water within your fluid plan' : 'sip water';

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
        `and ${sip}. Get medical help if they vomit, it gets worse, or it lasts longer than an hour.${ms}`,
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
