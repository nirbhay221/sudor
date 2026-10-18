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
import { SPACE_HEATER, type Heating } from './indoorcold.js';
import { registry, earlySupply, warmPlace } from './aid.js';
import { inUS } from './world.js';

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
  /** What follows is optional, so a caller that knows less still gets the general and medicine steps. */
  heating?: Heating;
  livesAlone?: boolean;
  youngChild?: boolean;
  dementia?: boolean;
  /** Oxygen at home, which a battery carries for hours, not days. */
  oxygen?: boolean;
  /** Stairs or getting out quickly are hard: a powered wheelchair (the 'wheelchair' equipment key), or age. */
  mobility?: boolean;
  /** A medicine or condition that makes heat harder on them, for the days after a storm takes the power. */
  heatSensitive?: boolean;
  /** Where they are, for the registries and refill rules that are a state's own. */
  state?: 'FL' | 'TX' | null;
  us?: boolean;
  /** ISO country code, for the help that is a country's own. See aid.ts. */
  country?: string;
  /** Condition ids from conditions.ts, for the steps each one needs. */
  conditions?: string[];
  /** A medicine dispensed daily at a clinic, which a disaster can close: methadone. */
  dailyClinic?: boolean;
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
    'After the water goes down, wear gloves and boots to clean up, throw out food and medicine it touched, and keep anybody with lung disease or a weak immune system out of damp rooms until they are dried out: mould grows within a day or two.',
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

/** Said to somebody whose equipment needs power, in fire weather. PG&E, SCE and SDG&E all keep such a list. */
const SHUTOFF =
  'In fire weather the power company may switch the power off on purpose to prevent fires, sometimes for a day or more. ' +
  'If you are not on its medical or life-support list, ring and ask to be added: they warn those customers first.';

/** Whether this hazard commonly takes the power out or forces people to leave home. */
const CUTS_POWER: Hazard[] = ['hurricane', 'winter', 'wind', 'tornado', 'flood', 'fire'];
const MAY_HAVE_TO_LEAVE: Hazard[] = ['hurricane', 'flood', 'fire', 'tsunami'];

export const mayLosePower = (h: Hazard): boolean => CUTS_POWER.includes(h);
export const mayHaveToLeave = (h: Hazard): boolean => MAY_HAVE_TO_LEAVE.includes(h);

/**
 * What a disaster asks of this person in particular, beyond medicines and equipment.
 *
 * Registries: Florida's counties keep a special needs registry for people who need help to evacuate or a shelter
 * with power, and stop new sign-ups 72 hours before tropical storm winds (Florida Department of Health). Texas
 * keeps STEAR, by 211 or online, which tells responders who needs help and promises no service (TDEM).
 * Refills: in Florida, once a hurricane warning or a state of emergency is declared, insurers must allow early
 * refills (Fla. Stat. 252.358); elsewhere the line is only to ask the pharmacist now.
 * Oxygen: a concentrator on battery runs about three to ten hours for a portable unit, so the backup is
 * cylinders from the supplier. After Hurricane Ida, nine people aged 64 to 79 in New Orleans died of heat in the
 * days the power was out (Louisiana Department of Health, September 2021), so the heat after a hurricane is said.
 * After a flood, the CDC's two that matter most: a wound in flood water and a tetanus shot, and the boil water
 * notice.
 *   https://nassau.floridahealth.gov/programs-and-services/emergency-preparedness-and-response/special-needs-shelter/
 *   https://tdem.texas.gov/response/state-of-texas-emergency-assistance-registry
 *   https://florida.public.law/statutes/fla._stat._252.358
 *   https://www.cdc.gov/floods/safety/index.html
 */
function particular(hazard: Hazard, needs: Needs): string[] {
  const out: string[] = [];
  const leave = mayHaveToLeave(hazard);
  const power = mayLosePower(hazard);
  // Anything that can take the power, the pharmacy or the house away for a while.
  const disrupt = power || leave;
  const has = (id: string): boolean => (needs.conditions ?? []).includes(id);
  const country = needs.country ?? (needs.us === false ? 'ZZ' : 'US');
  const helpToLeave = needs.poweredEquipment || needs.dialysis || needs.mobility || (needs.older && needs.livesAlone);
  if (helpToLeave && (leave || (power && needs.poweredEquipment))) out.push(registry(country, needs.state ?? null, hazard === 'hurricane'));
  if (needs.medicines && (hazard === 'hurricane' || leave)) out.push(earlySupply(country, needs.state ?? null, hazard === 'hurricane'));
  if (needs.dailyClinic && disrupt) {
    out.push(
      inUS(country)
        ? 'Ask your clinic today for take-home doses and a letter with your dose, in case it closes: after Hurricane Helene, many methadone clinics were shut for days. If you have to leave, a clinic near where you go can dose you as a guest.'
        : country === 'GB'
          ? "Ask your drug service today how you will get your doses if your pharmacy closes, and carry a letter with your dose. A pharmacist's emergency supply does not cover methadone."
          : 'Ask your clinic today how you will get your doses if it closes, and carry a letter with your dose.',
    );
  }
  if (needs.oxygen && disrupt) {
    out.push('A concentrator on battery lasts hours, about three to ten for a portable one, so ask your supplier today for spare oxygen cylinders, and keep them away from any flame.');
  }
  if (hazard === 'tornado' && needs.mobility) {
    out.push('If stairs are hard, choose your place now: a ground floor bathroom or closet with no windows, and a mattress or heavy blankets to cover you. In a mobile home, leave when a tornado watch is issued, not when the warning comes.');
  }
  if (hazard === 'hurricane' && (needs.older || needs.heatSensitive)) {
    out.push('After the storm the danger is often the heat with no power: after Hurricane Ida, nine people aged 64 to 79 in New Orleans died of heat in the days the power was out. Decide now where you would go to cool off.');
  }
  if (hazard === 'flood') {
    out.push('If you are cut in flood water, clean it well and ask about a tetanus shot, and follow any boil water notice before drinking from the tap.');
  }
  if ((hazard === 'winter' || hazard === 'cold') && needs.heating && needs.heating !== 'working') {
    out.push(needs.heating === 'space_heater' ? SPACE_HEATER.trim() : `Your heating cannot be relied on, so decide now where you will go if the house gets cold: a relative, a friend, or ${warmPlace(country)}.`);
  }

  // Conditions, each from the guidance written for it. See CONDITION_SOURCES below.
  if (has('pregnancy') && disrupt) {
    out.push('Leave early rather than late, and take your prenatal records, your vitamins and two weeks of medicines. Stay out of flood water, and wash your hands often in a shelter, where infections spread. Bleeding or fluid leaking, a bad headache or blurred vision, sudden swelling of the face or hands, or the baby moving less: get care straight away.');
  }
  if (has('sickle_cell') && (disrupt || hazard === 'cold')) {
    out.push('With sickle cell, the cold, the stress and too little to drink in a storm can set off a crisis: drink steadily, keep warm and dry, stay out of cold water, and carry your medicines and your pain plan. A fever of 101 degrees or more is an emergency for you.');
  }
  if (has('multiple_sclerosis') && disrupt) {
    out.push('When the power goes, your cooling goes with it, and a small rise in body temperature can bring MS symptoms back: pack a cooling vest or neck wrap and a battery fan, and know where you would go to cool off.');
  }
  if (has('spinal_cord_injury') && disrupt) {
    out.push('Pack a week of catheters, skin care and medicines, and a card that explains autonomic dysreflexia for whoever treats you: emergency staff may not know it. Your body may not warm or cool itself, so plan for both, and on a shelter cot shift your weight often to protect your skin.');
  }
  if (has('erythromelalgia') && disrupt) {
    out.push('If the power cut takes your cooling, a battery fan and cool water, never ice, are your plan for a flare.');
  }
  if (has('pots') && disrupt) {
    out.push('Pack water, electrolyte drinks, salty snacks and your compression stockings. Standing in a queue is the hard part: ask for a seat, and cross your legs or squat if you feel faint.');
  }
  if (has('raynauds') && (hazard === 'winter' || hazard === 'cold' || power)) {
    out.push('Keep gloves, warm socks and hand warmers in your bag, and your hands out of cold water: a cold house or a chilly shelter can set off an attack.');
  }
  if (has('migraine') && disrupt) {
    out.push('Pack your migraine medicine, an eye mask and earplugs: lost sleep, missed meals and a bright, noisy shelter are all triggers.');
  }
  if (has('hay_fever') && hazard === 'flood') {
    out.push('After a flood, mould grows within a day or two: keep out of damp rooms and keep your hay fever medicine with you.');
  }
  if (has('fasting') && (disrupt || hazard === 'heat')) {
    out.push('If you are fasting: scholars agree the fast is not required of somebody who is ill or travelling, and must be broken when it puts health in danger. Leaving home, or heat without power, is that time, so drink.');
  }

  if (needs.youngChild && disrupt) out.push("Have a week of formula or baby food, nappies and the child's medicines ready.");
  if (needs.dementia && disrupt) out.push('Ask somebody to stay with you through it, and keep a card in your pocket with your name, your medicines and a number to call.');
  if (needs.livesAlone && disrupt) out.push('Tell somebody you trust what your plan is, and agree a time they will check on you.');
  return out;
}

/*
 * CONDITION_SOURCES, for the lines above:
 *   Pregnancy: CDC, emergency preparedness during pregnancy, and its urgent maternal warning signs; Florida
 *     Department of Health, a two week supply and prenatal vitamins.
 *     https://www.cdc.gov/pregnancy/during/emergency-preparedness.html
 *   Sickle cell: CDC, a fever at about 101 F or more needs emergency care; cold, dehydration and stress as crisis triggers.
 *     https://www.cdc.gov/sickle-cell/complications/fever.html (101.3 F, 38.5 C; its emergency guide says above 101)
 *   Multiple sclerosis: MS Australia, a rise of 0.2 to 0.5 C in core temperature can worsen symptoms.
 *     https://www.msaustralia.org.au/wp-content/uploads/2016/03/MSAustralia_Keeping_Cool_Survey_Policy_Implications_Report_2009-3rd-ed2012-1.pdf
 *   Spinal cord injury: MSKTC emergency preparedness factsheet (a week of catheters, skin care and medicines);
 *     University of Washington SCI forum (an autonomic dysreflexia card).
 *     https://msktc.org/sci/factsheets/emergency-preparedness-and-sci
 *     https://sci.washington.edu/info/forums/reports/emergency_pre_tips.asp
 *   POTS: Kennedy Krieger factsheet: fluid, salt, compression, and long standing as a trigger.
 *     https://www.kennedykrieger.org/sites/default/files/library/documents/community/specialized-health-needs-interagency-collaboration-shnic/factsheets-medical-conditions/POTS_1.pdf
 *   Fasting: the exemption for the ill and the traveller, and the duty to break a fast that endangers health.
 *     https://zakat.org/valid-exemptions-for-not-fasting-ramadan
 *   Methadone: STAT on clinics closed after Hurricane Helene; ASPR TRACIE on methadone patients in emergencies.
 *     https://www.statnews.com/2025/07/23/methadone-clinics-otp-climate-disaster-disrupted-treatment-texas-floods-hurricane-helene/
 *     https://files.asprtracie.hhs.gov/documents/aspr-tracie-ta-methadone-patients-during-emergencies-12-30-16-508.pdf
 */

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
    // In fire weather the power company may switch the power off on purpose, a Public Safety Power Shutoff, often for a
    // day or more, and a Red Flag Warning is the first thing it weighs. Customers on its medical list are warned first.
    if (hazard === 'fire' && needs.poweredEquipment) personal.push(SHUTOFF);
    if (leave && needs.coldMedicine) personal.push('If you leave, carry your insulin or injection pen in a small cooler with an ice pack, not touching the ice.');
    if (leave && needs.medicines) personal.push('Take your medicines and the written list with you.');
    if (hazard === 'winter' && needs.heart) personal.push('Do not shovel snow. It can push a heart to its limit within minutes, so ask somebody else.');
    if (hazard === 'winter' && needs.older) personal.push('A house at 60 to 65 degrees is cold enough to bring on hypothermia at your age, so do not wait for it to feel dangerous.');
    if (hazard === 'tornado' && needs.medicines) personal.push('If there is time, take your medicines and your phone into the room with you.');
    personal.push(...particular(hazard, needs));
    // The detailed advice already says to charge everything, so the general line that says it again is left out.
    const rest = general.slice(1).filter((g) => !(/^Charge your phone/.test(g) && detailed.some((d) => /^Charge your phone/.test(d))));
    return [general[0], ...detailed, ...personal, ...rest];
  }

  if (needs.poweredEquipment && power) {
    personal.push(`Your ${needs.poweredNames ?? 'medical equipment'} needs power, so do not wait for the lights to go out: charge every battery now, and plan where you would go that has a generator.`);
  }
  // In fire weather the power company may switch the power off on purpose, a Public Safety Power Shutoff, often for a
  // day or more, and a Red Flag Warning is the first thing it weighs. Customers on its medical list are warned first.
  if (hazard === 'fire' && needs.poweredEquipment) personal.push(SHUTOFF);
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
  personal.push(...particular(hazard, needs));

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
