/**
 * What an official warning means for one person.
 *
 * The weather service says a hurricane is coming, and says the same thing to everybody in the county. What
 * it cannot say is what that means for somebody on home oxygen, or with insulin in the fridge, or who should
 * not be shovelling. This turns the warning that is active where a person lives into the first things for
 * that person to do, in the order they matter.
 *
 * The general steps for each hazard are the federal ones, from Ready.gov and the CDC, shortened to what can
 * be said aloud. The personal steps are joined on from what the person has told Sudor: what they take, what
 * they have, and what in their home needs power. Nothing here is a forecast and nothing replaces the local
 * instruction: if officials say leave, the answer is to leave.
 *
 * Hand-written from those sources, on purpose: there is no feed of "what to do", only of what is coming.
 * What is coming is always read live.
 */

import type { Alert } from './warnings.js';

export type Hazard = 'hurricane' | 'flood' | 'tornado' | 'winter' | 'smoke' | 'heat' | 'cold' | 'wind' | 'tsunami' | 'fire' | 'other';

export function hazardOf(event: string): Hazard {
  const e = event.toLowerCase();
  if (/tsunami/.test(e)) return 'tsunami';
  if (/hurricane|tropical|typhoon|storm surge/.test(e)) return 'hurricane';
  if (/tornado/.test(e)) return 'tornado';
  if (/flood/.test(e)) return 'flood';
  if (/blizzard|winter storm|ice storm|snow|freezing rain|sleet|lake effect/.test(e)) return 'winter';
  if (/red flag|fire weather|wildfire|evacuation/.test(e) && !/smoke/.test(e)) return 'fire';
  if (/smoke|air quality|dust|ozone|ash/.test(e)) return 'smoke';
  if (/heat/.test(e)) return 'heat';
  if (/wind chill|cold|freeze|frost/.test(e)) return 'cold';
  if (/thunderstorm|high wind|wind advisory|derecho/.test(e)) return 'wind';
  return 'other';
}

/** What the person has that changes the advice. Never spoken as a diagnosis; only as what to do. */
export type Needs = {
  /** Medicine that has to stay cold: insulin, or an injection pen. */
  coldMedicine: boolean;
  /** Something they breathe with, or are treated by, that plugs into the wall. */
  poweredEquipment: boolean;
  /** What it is, in their words, when they have said: "oxygen concentrator". */
  poweredNames?: string;
  dialysis: boolean;
  breathing: boolean;
  heart: boolean;
  /** Takes any medicine at all, so a supply and a written list matter. */
  medicines: boolean;
  older: boolean;
};

const GENERAL: Record<Hazard, string[]> = {
  hurricane: [
    'If you are told to leave, leave, and go early: roads and shelters fill up.',
    'Fill the car, charge your phone, and put water, food and your papers where you can carry them.',
    'Stay inside and away from windows once the wind arrives, and stay out of flood water afterwards.',
  ],
  flood: [
    'Do not walk or drive through flood water. A foot of moving water can carry a car away.',
    'Move to higher ground or a higher floor if water is rising, and leave if you are told to.',
    'Keep your phone charged and your medicines somewhere high and dry.',
  ],
  tornado: [
    'Go now to the lowest floor, in a room with no windows, and put as many walls between you and outside as you can.',
    'Cover your head and neck, and stay there until the warning ends.',
    'If you are in a car or a mobile home, get to a sturdy building.',
  ],
  winter: [
    'Stay in if you can, and keep one room warm rather than the whole house if the heating goes.',
    'Never run a generator, grill or camping stove indoors or in the garage: that is carbon monoxide.',
    'Keep blankets, water and a charged phone where you can reach them in the dark.',
  ],
  smoke: [
    'Stay indoors with the windows and doors shut, and run the air conditioning on recirculate if you have it.',
    'If you have to go out, a well fitted N95 mask helps. A cloth or surgical mask does not.',
    'Do not add to it indoors: no candles, no frying, no vacuuming.',
  ],
  heat: [
    'Stay somewhere air conditioned through the hottest part of the day. A fan alone is not enough above the high nineties.',
    'Drink before you are thirsty, and check on anybody who lives alone.',
  ],
  cold: [
    'Stay in if you can. If you go out, cover every bit of skin and keep it short.',
    'Never heat the house with an oven, a grill or a generator indoors: that is carbon monoxide.',
  ],
  wind: [
    'Stay inside and away from windows while the wind is up.',
    'Charge your phone now, and treat any fallen wire as live.',
  ],
  tsunami: [
    'Move inland or to higher ground now. Do not wait to see the water.',
    'Stay there until officials say it is safe: the first wave is often not the largest.',
  ],
  fire: [
    'Be ready to leave at once, and go the moment you are told to. Do not wait for the flames.',
    'Put your medicines, papers and phone charger by the door now.',
  ],
  other: ['Follow what local officials say, and keep your phone charged.'],
};

/** Whether this hazard commonly takes the power out or forces people to leave home. */
const CUTS_POWER: Hazard[] = ['hurricane', 'winter', 'wind', 'tornado', 'flood', 'fire'];
const MAY_HAVE_TO_LEAVE: Hazard[] = ['hurricane', 'flood', 'fire', 'tsunami'];

export const mayLosePower = (h: Hazard): boolean => CUTS_POWER.includes(h);
export const mayHaveToLeave = (h: Hazard): boolean => MAY_HAVE_TO_LEAVE.includes(h);

/**
 * The steps for this person, most important first: what the hazard asks of anybody, then what it asks of
 * them in particular. The first general step always comes first, because "go to the lowest floor now" is
 * not something to say after a sentence about a pharmacy.
 */
export function stepsFor(hazard: Hazard, needs: Needs, detailed: string[] = []): string[] {
  const general = GENERAL[hazard];
  const personal: string[] = [];
  const leave = mayHaveToLeave(hazard);
  const power = mayLosePower(hazard);
  // The caller may already hold the full advice on medicines and equipment in a power cut: insulin's
  // temperature range, the dialysis emergency diet. Where the hazard can cut the power or empty the house,
  // that is said in full, and the short lines below that say the same thing are left out.
  const full = (power || leave) && detailed.length > 0;
  if (full) {
    if (leave && needs.poweredEquipment) personal.push(`If you leave, take your ${needs.poweredNames ?? 'medical equipment'}, its charger and any spare battery, and go somewhere that has power.`);
    if (leave && needs.coldMedicine) personal.push('If you leave, carry your insulin or injection pen in a small cooler with an ice pack, not touching the ice.');
    if (leave && needs.medicines) personal.push('Take your medicines and the written list with you.');
    if (hazard === 'winter' && needs.heart) personal.push('Do not shovel snow. It can push a heart to its limit within minutes, so ask somebody else.');
    if (hazard === 'winter' && needs.older) personal.push('A house at 60 to 65 degrees is cold enough to bring on hypothermia at your age, so do not wait for it to feel dangerous.');
    if (hazard === 'tornado' && needs.medicines) personal.push('If there is time, take your medicines and your phone into the room with you.');
    // The detailed advice already says to charge everything, so the general line that says it again is left out.
    const rest = general.slice(1).filter((g) => !(/^Charge your phone/.test(g) && detailed.some((d) => /^Charge your phone/.test(d))));
    return [general[0], ...detailed, ...personal, ...rest];
  }

  if (needs.poweredEquipment && power) {
    personal.push(`Your ${needs.poweredNames ?? 'medical equipment'} needs power, so do not wait for the lights to go out: charge every battery now, and plan where you would go that has a generator.`);
  }
  if (needs.dialysis && (power || leave)) {
    personal.push('Ring your dialysis unit today and ask where to go if they close or you cannot get there.');
  }
  if (needs.coldMedicine && (power || leave)) {
    personal.push(leave ? 'Pack your insulin or injection pen in a small cooler with an ice pack, not touching the ice, ready to carry.' : 'Have a small cooler and ice ready for your insulin or injection pen in case the fridge goes off.');
  }
  if (needs.medicines && leave) personal.push('Take a week of every medicine you use, and a written list of the names and doses.');
  if (needs.medicines && !leave && power) personal.push('Make sure you have a week of every medicine you take, and the names and doses written on paper.');
  if (hazard === 'smoke' && (needs.breathing || needs.heart)) {
    personal.push('Smoke is harder on you than on most people. Keep your reliever inhaler or your heart medicines within reach, and call your doctor if your breathing or chest gets worse.');
  }
  if (hazard === 'winter' && needs.heart) personal.push('Do not shovel snow. It can push a heart to its limit within minutes, so ask somebody else.');
  if ((hazard === 'winter' || hazard === 'cold') && needs.older) personal.push('A house at 60 to 65 degrees is cold enough to bring on hypothermia at your age, so do not wait for it to feel dangerous.');
  if (hazard === 'tornado' && needs.medicines) personal.push('If there is time, take your medicines and your phone into the room with you.');

  // The first thing for anybody, then everything particular to them, then the rest of the general advice.
  return [general[0], ...personal, ...general.slice(1)];
}

/** One line a family member can act on. Nothing about health is in it. */
export function forFamily(alert: Alert, place: string | null): string {
  return `There is ${/^[aeiou]/i.test(alert.event) ? 'an' : 'a'} ${alert.event} in effect${place ? ` for ${place}` : ' where they live'}. Please check in with them.`;
}

export const SOURCES: Record<Hazard, string> = {
  hurricane: 'https://www.ready.gov/hurricanes',
  flood: 'https://www.ready.gov/floods',
  tornado: 'https://www.ready.gov/tornadoes',
  winter: 'https://www.ready.gov/winter-weather',
  smoke: 'https://www.cdc.gov/wildfires/safety/how-to-safely-stay-safe-during-a-wildfire.html',
  heat: 'https://www.ready.gov/heat',
  cold: 'https://www.cdc.gov/winter-weather/prevention/index.html',
  wind: 'https://www.ready.gov/thunderstorms-lightning',
  tsunami: 'https://www.ready.gov/tsunamis',
  fire: 'https://www.ready.gov/wildfires',
  other: 'https://www.ready.gov/alerts',
};
