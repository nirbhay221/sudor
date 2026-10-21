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
  /** Answered without assuming the heat, because it is not hot where they are. */
  mild?: boolean;
};

const NWS = { name: 'National Weather Service, Heat Illness', url: 'https://www.weather.gov/safety/heat-illness' };
// "Do NOT give the person medicines used to treat fever (such as aspirin or acetaminophen). They will not
// help, and they may be harmful." A body overheated from outside is not a fever, and these act on fever.
const MEDLINE = { name: 'MedlinePlus, Heat emergencies', url: 'https://medlineplus.gov/ency/article/000056.htm' };
const NIOSH = { name: 'CDC NIOSH, Heat-related Illnesses and First Aid', url: 'https://www.cdc.gov/niosh/heat-stress/about/illnesses.html' };
const NHS_FAINT = { name: 'NHS, Fainting', url: 'https://www.nhs.uk/symptoms/fainting/' };
const AHA_CPR = { name: 'American Heart Association, Hands-Only CPR', url: 'https://cpr.heart.org/en/cpr-courses-and-kits/hands-only-cpr' };
const CDC_SEIZURE = { name: 'CDC, First Aid for Seizures', url: 'https://www.cdc.gov/epilepsy/first-aid-for-seizures/index.html' };
const ADA_LOW = { name: 'American Diabetes Association, Low Blood Glucose', url: 'https://diabetes.org/living-with-diabetes/hypoglycemia-low-blood-glucose' };

/**
 * What the weather and the person add to the answer.
 *
 * mild: it is neither hot nor cold where they are, and nothing said points to heat. Fainting on a 75 degree
 * afternoon is far more often the heart, a stroke, low blood sugar or a medicine than the heat, and calling it
 * heat stroke sends the family the wrong way. Then the answer still says call now, but does not name a cause.
 * Even on a hot day it says the signs have other causes too: Sudor cannot tell which, and the operator can.
 *
 * tell: what to tell the operator, from what the customer has already said about the person ("Mum is 82 and
 * takes furosemide"). Dispatchers ask for the conditions and the medicines, and in a panic people forget.
 */
export type Setting = { mild?: boolean; tell?: string; why?: 'mild' | 'cool' };

/** Do not guess the cause. Only the steps the first aid bodies give for the sign that was described. */
function steps(stroke: string[], p: Profile | undefined, mild: boolean): string[] {
  const out: string[] = [];
  const faint = stroke.includes('fainting or collapse');
  if (stroke.includes('a seizure')) out.push('If they are shaking or jerking, turn them on their side, put nothing in their mouth, and time it.');
  if (faint) {
    out.push(
      mild
        ? `If they are breathing, lay them on their ${p?.conditions.some((c) => c.id === 'pregnancy') ? 'left side' : 'back and raise their legs'}.`
        : 'If they are breathing, lay them down somewhere cool.',
    );
    out.push('If they are not breathing normally, push hard and fast in the middle of their chest until help comes.');
  }
  return out;
}
/** For somebody on insulin: sugar only when awake and able to swallow, otherwise nothing by mouth. See ADA. */
const SUGAR = 'Because of the insulin: if they are awake and can swallow, give them juice or something sugary. If not, put nothing in their mouth.';

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

export function triage(description: string, p?: Profile, lastedMinutes?: number, setting: Setting = {}): Triage {
  const mild = !!setting.mild;
  const tell = setting.tell ? ` ${setting.tell}` : '';
  const notHeat = setting.why === 'cool' ? 'They have been somewhere cool, so this may not be the heat' : "It isn't hot there, so this may not be the heat";
  const text = description.toLowerCase();
  const stroke = STROKE_SIGNS.filter(([re]) => described(text, re)).map(([, s]) => s);
  if (fever(text)) stroke.push('a temperature above 103');
  const exhaustion = EXHAUSTION_SIGNS.filter(([re]) => described(text, re)).map(([, s]) => s);
  const vomiting = described(text, VOMIT);
  const cramps = described(text, CRAMPS);
  const sources = [NWS, NIOSH];

  if (stroke.length) {
    const how = steps(stroke, p, mild);
    const insulin = !!p?.insulin;
    const extra = [...(stroke.includes('fainting or collapse') ? [NHS_FAINT, AHA_CPR] : []), ...(stroke.includes('a seizure') ? [CDC_SEIZURE] : []), ...(insulin ? [ADA_LOW] : [])];
    if (mild) {
      return {
        level: 'emergency',
        matched: stroke,
        spoken:
          `This is an emergency. Call 911 now.${tell} ${notHeat}: tell them exactly what happened and do what they say.` +
          (how.length ? ` ${how.join(' ')}` : '') +
          (insulin ? ` ${SUGAR}` : ' Give them nothing to eat or drink until they are fully awake.'),
        sources: extra,
        mild: true,
      };
    }
    return {
      level: 'emergency',
      matched: stroke,
      spoken:
        `This is an emergency. Call 911 now.${tell} In this heat it can be heat stroke, though it can have other causes too, so tell them exactly what happened. ` +
        'While you wait, move them somewhere cool and cool them with cool wet cloths or a cool bath.' +
        (how.length ? ` ${how.join(' ')}` : '') +
        (insulin ? ` ${SUGAR} No fever medicine.` : ' Give them nothing to drink and no fever medicine.'),
      sources: [...sources, MEDLINE, ...extra],
    };
  }

  const cool = p?.noIce ? 'cool, not icy, wet cloths' : 'cool wet cloths or a cool bath';
  const fasting = !!p?.conditions.some((c) => c.id === 'fasting');
  const sip = p?.fluidLimit ? 'sip water within your fluid plan' : fasting ? 'break your fast and sip water' : 'sip water';

  if (mild && (vomiting || exhaustion.length || cramps)) {
    const urgent = vomiting || (lastedMinutes != null && lastedMinutes > 60);
    return {
      level: urgent ? 'urgent' : 'self_care',
      matched: [...exhaustion, ...(vomiting ? ['vomiting'] : []), ...(cramps ? ['cramps'] : [])],
      spoken: urgent
        ? `Get medical help now: call a doctor or urgent care.${tell} ${notHeat}. Call 911 if they faint, get confused, or have chest pain or trouble breathing.`
        : `${notHeat}. Sit or lie down somewhere comfortable and sip water${p?.fluidLimit ? ' within your fluid plan' : ''}. Call a doctor if it does not pass or gets worse, and 911 if there is fainting, confusion, chest pain or trouble breathing.`,
      sources: [NHS_FAINT],
      mild: true,
    };
  }

  if (vomiting || (exhaustion.length && lastedMinutes != null && lastedMinutes > 60)) {
    return {
      level: 'urgent',
      matched: [...exhaustion, ...(vomiting ? ['vomiting'] : [])],
      spoken:
        `Get medical help now.${tell} With heat exhaustion, ${vomiting ? 'vomiting' : 'symptoms lasting more than an hour'} ` +
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
        `and ${sip}. Aspirin, acetaminophen and ibuprofen will not bring it down, so do not take them for this. Get medical help if there is vomiting, it gets worse, or it lasts longer than an hour.${ms}`,
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
      `weakness and a headache: cool down, ${sip}, and get help if it lasts over an hour or there is vomiting.`,
    sources,
  };
}
