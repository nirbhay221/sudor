/**
 * Conditions that change how a body copes with heat, and what actually helps.
 *
 * Medications are only half of who is at risk. The CDC names people with
 * chronic conditions, pregnant people and adults 65 and over as more prone to
 * heat illness, and some conditions are far more specific than that: multiple
 * sclerosis symptoms flare with a rise in core temperature, erythromelalgia
 * flares are triggered by heat, and a spinal cord injury takes sweating away
 * below the injury.
 *
 * Two things in this file matter more than the rest. First, sensitivity is
 * graded the way the NWS and CDC HeatRisk scale grades people: "extremely
 * sensitive" people are affected a level before "sensitive" people, who are
 * affected a level before everyone else. Second, the advice is specific where
 * the generic advice would do harm. Ice is the standard cooling advice, and
 * for erythromelalgia it damages skin. "Drink more" is the standard advice, and
 * for someone on dialysis with a fluid limit it is wrong.
 *
 * Every entry names its source. Nothing here is a diagnosis or a treatment
 * plan, and nothing tells anyone to change a medication.
 */

export type Sensitivity = 'extreme' | 'sensitive';
export type Source = { name: string; url: string };

export type Condition = {
  id: string;
  /** How it is said aloud, "multiple sclerosis". */
  label: string;
  aliases: string[];
  sensitivity: Sensitivity;
  /** Hot afternoons also carry worse air, which matters for this condition. */
  airQuality?: boolean;
  /** Ice and cold water cause harm here, so cooling advice must say cool, not cold. */
  noIce?: boolean;
  /** Carries insulin, which heat ruins. */
  insulin?: boolean;
  /** May have a fluid limit, so this must never simply say drink more. */
  fluidLimit?: boolean;
  /** One sentence for planning a day around. */
  plan: string;
  /**
   * The winter half. Present only where a source says cold changes this
   * condition, because a made up cold warning is worse than none: it teaches
   * people to ignore the real ones.
   */
  cold?: { plan: string; goingOut: string[]; sources: Source[] };
  /** Precautions for going out anyway, most important first. */
  goingOut: string[];
  sources: Source[];
};

const SRC = {
  hypothermia: { name: 'StatPearls, Hypothermia', url: 'https://www.ncbi.nlm.nih.gov/books/NBK545239/' },
  cdcOlder: {
    name: 'CDC, Older adults and cold weather, Winter Weather',
    url: 'https://www.cdc.gov/winter-weather/risk-factors/index.html',
  },
  ahaShovel: {
    name: 'American Heart Association, snow shoveling and cold temperatures',
    url: 'https://newsroom.heart.org/news/snow-shoveling-cold-temperatures-combine-for-perfect-storm-of-heart-health-hazards',
  },
  coldAirways: {
    name: 'The impact of cold on the respiratory tract, Respiratory Medicine',
    url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC6031196/',
  },
  cdcSickle: { name: 'CDC, About Sickle Cell Disease', url: 'https://www.cdc.gov/sickle-cell/about/' },
  sickleWeather: {
    name: 'Effect of Weather on Frequency of Vaso-Occlusive Crisis in Children With Sickle Cell Disease',
    url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC8445241/',
  },
  niamsRaynaud: {
    name: 'NIAMS, Raynaud phenomenon, diagnosis, treatment and steps to take',
    url: 'https://www.niams.nih.gov/health-topics/raynauds-phenomenon/diagnosis-treatment-and-steps-to-take',
  },
  uhthoff: { name: 'StatPearls, Uhthoff Phenomenon', url: 'https://www.ncbi.nlm.nih.gov/books/NBK470244/' },
  msTrust: { name: 'MS Trust, Heat sensitivity and MS', url: 'https://mstrust.org.uk/a-z/heat-sensitivity-uhthoffs-phenomenon' },
  emStatPearls: { name: 'StatPearls, Erythromelalgia', url: 'https://www.ncbi.nlm.nih.gov/books/NBK557787/' },
  emGuide: {
    name: "The Erythromelalgia Association, A Patient's Guide to Erythromelalgia",
    url: 'https://erythromelalgia.org/wp-content/uploads/2017/09/TEA-PatientGuideBook-1.pdf',
  },
  sciFrontiers: {
    name: 'Risks of Heat Illness in Athletes With Spinal Cord Injury, Frontiers in Sports and Active Living, 2019',
    url: 'https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2019.00068/full',
  },
  sciReview: { name: 'Thermoregulation following spinal cord injury, Handbook of Clinical Neurology', url: 'https://pubmed.ncbi.nlm.nih.gov/30459042/' },
  potsHeat: {
    name: 'The effect of heat stress on orthostatic tolerance in PoTS, Autonomic Neuroscience',
    url: 'https://www.autonomicneuroscience.com/article/S1566-0702(13)00660-7/abstract',
  },
  potsWork: {
    name: 'Work ability and cardiovascular autonomic profile in POTS',
    url: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7662324/',
  },
  cdcHeart: {
    name: 'CDC, Clinical Overview of Heat and Cardiovascular Disease',
    url: 'https://www.cdc.gov/heat-health/hcp/clinical-overview/heat-and-people-with-cardiovascular-disease.html',
  },
  cdcChronic: { name: 'CDC, Heat and Chronic Conditions', url: 'https://www.cdc.gov/heat-health/risk-factors/heat-and-chronic-conditions.html' },
  airnowOzone: { name: 'AirNow, Air Quality Guide for Ozone', url: 'https://document.airnow.gov/air-quality-guide-for-ozone.pdf' },
  adaInsulin: {
    name: 'American Diabetes Association, Safe Storage of Insulin',
    url: 'https://diabetes.org/sites/default/files/2024-04/ddrc-storing-insulin-2018.pdf',
  },
  diatribe: { name: 'diaTribe, How to keep your insulin cool', url: 'https://diatribe.org/diabetes-medications/how-help-keep-your-insulin-cool' },
  cdcPregnancy: { name: 'CDC, Heat and Pregnancy', url: 'https://www.cdc.gov/heat-health/risk-factors/heat-and-pregnancy.html' },
  cdcRisk: { name: 'CDC, Heat and Your Health, groups at higher risk', url: 'https://www.cdc.gov/heat-health/risk-factors/index.html' },
} satisfies Record<string, Source>;

export const CONDITIONS: Condition[] = [
  {
    id: 'multiple_sclerosis',
    label: 'multiple sclerosis',
    aliases: ['multiple sclerosis', 'ms'],
    sensitivity: 'extreme',
    plan: 'Heat sensitivity affects 60 to 80 percent of people with MS, so plan time outside for the coolest part of the day.',
    goingOut: [
      'Cool down before you go, and take something to stay cool, like a cooling vest, a neck wrap or a cold drink.',
      'Symptoms brought on by heat usually settle within a day once you cool down. A new symptom that does not settle needs your doctor.',
    ],
    sources: [SRC.uhthoff, SRC.msTrust],
  },
  {
    id: 'erythromelalgia',
    label: 'erythromelalgia',
    aliases: ['erythromelalgia', 'erythermalgia'],
    sensitivity: 'extreme',
    noIce: true,
    plan: 'Heat, exercise and standing are the usual flare triggers, so keep time outside to the coolest hours and keep it short.',
    goingOut: [
      'Cool a flare with a fan or a short soak in cool water, never ice or cold water, which can damage skin and set off a rebound flare.',
      'Wear loose, light clothing and footwear, and rest with your feet or hands raised when you can.',
    ],
    sources: [SRC.emStatPearls, SRC.emGuide],
  },
  {
    id: 'spinal_cord_injury',
    label: 'a spinal cord injury',
    aliases: ['spinal cord injury', 'sci', 'tetraplegia', 'quadriplegia', 'paraplegia'],
    sensitivity: 'extreme',
    plan: 'Sweating is reduced below the injury, most of all with injuries above T6, so your body sheds heat poorly. Keep time outside to the cool hours.',
    goingOut: [
      'Bring your own cooling, like shade, a wet cloth and cool drinks, because your skin cannot sweat the heat away for you.',
    ],
    cold: {
      plan: 'Below the level of the injury the body cannot shiver or close down blood vessels to hold heat, so cold takes hold faster and with less warning than it does for other people.',
      goingOut: [
        'Add layers before you go out rather than after you feel cold, and cover the legs and feet even when they feel fine.',
        'Keep the time outside short, and have somewhere warm at the other end of the trip.',
      ],
      sources: [SRC.hypothermia, SRC.sciReview],
    },
    sources: [SRC.sciFrontiers, SRC.sciReview],
  },
  {
    id: 'pots',
    label: 'POTS',
    aliases: ['pots', 'postural tachycardia', 'postural orthostatic tachycardia', 'dysautonomia'],
    sensitivity: 'sensitive',
    plan: 'Heat makes standing symptoms worse with POTS, so plan around queues and waiting outside in the heat.',
    goingOut: ['Avoid standing still in the heat, like queues or bus stops, and sit down if you start to feel lightheaded.'],
    sources: [SRC.potsHeat, SRC.potsWork],
  },
  {
    id: 'heart_disease',
    label: 'heart disease',
    aliases: ['heart disease', 'heart failure', 'coronary artery disease', 'heart condition', 'atrial fibrillation', 'afib', 'arrhythmia'],
    sensitivity: 'sensitive',
    airQuality: true,
    plan: 'Hot days also worsen air quality, which raises the risk of heart attacks and arrhythmias, so avoid the hottest part of the day.',
    goingOut: ['Take it slow, skip anything strenuous, and keep your medicines with you.'],
    cold: {
      plan: 'Cold raises blood pressure and makes the heart work harder, and shovelling snow is the specific danger: ten minutes of it can push a heart to almost its maximum rate.',
      goingOut: [
        'Do not shovel snow. If it has to be done, ask someone else, or push rather than lift and stop the moment you feel anything in your chest, arm or jaw.',
        'Cover your mouth with a scarf so you are not breathing cold air in hard.',
      ],
      sources: [SRC.ahaShovel],
    },
    sources: [SRC.cdcHeart, SRC.cdcChronic],
  },
  {
    id: 'asthma_copd',
    label: 'asthma or COPD',
    aliases: ['asthma', 'copd', 'emphysema', 'chronic bronchitis', 'lung disease'],
    sensitivity: 'sensitive',
    airQuality: true,
    plan: 'Ozone is worse in the afternoon and early evening on hot days, so mornings are better for being outside.',
    goingOut: [
      'Follow your action plan and keep your quick relief medicine handy.',
      'Make anything you do outside shorter and less intense, and take more breaks.',
    ],
    cold: {
      plan: 'Cold air narrows the airways, so the coldest hours are the worst ones to be out in, and a sharp change from warm indoors to freezing outdoors is worse than the cold itself.',
      goingOut: [
        'Breathe through a scarf held loosely over your nose and mouth, so the air is warmer by the time it reaches your lungs.',
        'Carry your reliever inhaler, and keep it in an inside pocket where it stays warm.',
      ],
      sources: [SRC.coldAirways],
    },
    sources: [SRC.airnowOzone, SRC.cdcChronic],
  },
  {
    id: 'kidney_disease',
    label: 'kidney disease',
    aliases: ['kidney disease', 'chronic kidney disease', 'ckd', 'dialysis', 'renal failure'],
    sensitivity: 'sensitive',
    fluidLimit: true,
    plan: 'Dehydration can injure kidneys, and some of that damage can become permanent, so keep time in the heat short.',
    goingOut: ['Follow the fluid plan from your care team for hot days, rather than drinking extra on your own.'],
    sources: [SRC.cdcChronic],
  },
  {
    id: 'diabetes',
    label: 'diabetes',
    aliases: ['diabetes', 'diabetic', 'type 1 diabetes', 'type 2 diabetes'],
    sensitivity: 'sensitive',
    insulin: true,
    plan: 'Heat can change blood sugar and ruin insulin, so plan time outside for cooler hours.',
    goingOut: [
      'Keep insulin out of the heat and out of direct sun. Above 86 degrees it starts to break down, so carry it in a cool bag and never leave it in a hot car.',
      'Check your blood sugar more often, because heat can change it.',
    ],
    cold: {
      plan: 'Nerve damage in the feet means cold and early frostbite can go unnoticed, and low blood sugar itself lowers body temperature.',
      goingOut: [
        'Wear dry socks and boots with room in them, and look at your feet when you get back rather than going by feel.',
        'Carry something sugary: being cold uses energy, and a low is harder to notice outside.',
      ],
      sources: [SRC.hypothermia, SRC.cdcChronic],
    },
    sources: [SRC.adaInsulin, SRC.diatribe],
  },
  {
    id: 'pregnancy',
    label: 'pregnancy',
    aliases: ['pregnant', 'pregnancy', 'expecting a baby'],
    sensitivity: 'sensitive',
    plan: 'Even one day of high heat can raise risks in pregnancy, so keep time in the heat short.',
    goingOut: ['Keep the trip short, stay in shade or air conditioning, and drink water regularly.'],
    sources: [SRC.cdcPregnancy],
  },
  {
    id: 'sickle_cell',
    label: 'sickle cell disease',
    aliases: ['sickle cell', 'sickle cell disease', 'sickle cell anemia', 'sickle cell anaemia', 'scd'],
    sensitivity: 'extreme',
    plan: 'Sudden temperature changes in either direction can set off a pain crisis, so the hours to avoid are the ones where it swings, not only the hot ones.',
    goingOut: [
      'Keep a layer with you even on a warm day, for air conditioning indoors and the evening drop.',
      'Drink steadily. Being short of fluid makes a crisis more likely.',
    ],
    cold: {
      plan: 'Cold is the bigger risk for you: vessels narrow, blood thickens, and crises peak in the coldest months, with January the worst.',
      goingOut: [
        'Cover hands, feet, ears and head before you go out, and change out of anything damp the moment you are back in.',
        'Ease into cold water rather than getting in quickly, and keep drinks warm rather than iced.',
      ],
      sources: [SRC.cdcSickle, SRC.sickleWeather],
    },
    sources: [SRC.cdcSickle, SRC.sickleWeather],
  },
  {
    id: 'raynauds',
    label: "Raynaud's",
    aliases: ["raynaud's", 'raynauds', 'raynaud', "raynaud's phenomenon", "raynaud's disease"],
    sensitivity: 'sensitive',
    plan: 'Heat is not the problem here. Air conditioning indoors can be, so carry something warm even on a hot day.',
    goingOut: ['Take a layer for cold indoor places, and keep your hands out of the freezer aisle.'],
    cold: {
      plan: 'Cold, and even a sudden change into cold, closes down the vessels in the fingers and toes, and keeping the chest and head warm matters as much as gloves do.',
      goingOut: [
        'Gloves and a hat before you step out, not after your hands start to hurt, and keep your core warm so your body is not pulling blood away from your hands.',
        'Use hand warmers for anything that keeps you still outside, and wear gloves to handle anything frozen.',
      ],
      sources: [SRC.niamsRaynaud],
    },
    sources: [SRC.niamsRaynaud],
  },
  {
    id: 'older_adult',
    label: 'age 65 or over',
    aliases: ['older adult', 'over 65', '65 or older', 'senior', 'elderly'],
    sensitivity: 'sensitive',
    plan: 'People 65 and older are more prone to heat related health problems, so plan time outside for the cooler hours.',
    goingOut: ['Go in the cooler hours, keep it short, and take water with you.'],
    cold: {
      plan: 'Hypothermia in older adults often happens indoors, in a house that is only a little too cold, because the body holds heat less well and the drop is slow enough not to register.',
      goingOut: [
        'Keep the house warm, and if heating is a worry, heat one room properly rather than the whole house badly.',
        'Wear a hat outside, and layers you can take off indoors so you do not end up damp with sweat.',
      ],
      sources: [SRC.hypothermia, SRC.cdcOlder],
    },
    sources: [SRC.cdcRisk],
  },
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Match what someone says, "I have MS" or "my husband is on dialysis", to a condition. */
export function findCondition(spoken: string): Condition | null {
  const text = ` ${spoken.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  // Longest alias first, so "type 1 diabetes" wins over a shorter overlapping word.
  const pairs = CONDITIONS.flatMap((c) => c.aliases.map((a) => ({ c, a }))).sort((x, y) => y.a.length - x.a.length);
  for (const { c, a } of pairs) {
    if (new RegExp(`\\s${escape(a)}\\s`).test(text)) return c;
  }
  /*
   * Nobody describes themselves as an "older adult". They say how old they are,
   * and a test written the way a person actually speaks is what found this: "I
   * am 80 years old" matched nothing at all, so the entire indoor-hypothermia
   * half of the cold advice never reached the people it was written for.
   * Sixty-five is the line the CDC and the National Institute on Aging draw, and
 * "is" is in there because half of these profiles are set up by a daughter
 * saying "my mother is 88" rather than by the person themselves.
   */
  const age = text.match(/\s(?:i am|i m|im|aged|age|is|are)\s(\d{2,3})\s/) ?? text.match(/\s(\d{2,3})\s(?:years? old|yo)\s/);
  const years = age ? Number(age[1]) : NaN;
  if (years >= 65 && years <= 120) return conditionById('older_adult') ?? null;
  return null;
}

export const conditionById = (id: string): Condition | undefined => CONDITIONS.find((c) => c.id === id);
