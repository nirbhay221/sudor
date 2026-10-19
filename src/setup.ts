/**
 * Asking, a question at a time, for what changes the answer.
 *
 * Sudor answered whoever spoke, with whatever they had happened to say. Somebody who never mentioned their
 * pills got the same answer as everybody else, and was told so in a sentence that did not ask anything. The
 * research this project is built on says why that is not enough: older adults using voice assistants at home
 * ran into breakdowns when the assistant expected them to know what to say (Mahmood and others, 2024), and
 * every one of the things below changes what the heat and the cold do to a body or who should be told.
 *
 * So after an ordinary answer, with nothing more urgent to say, one question is put, the most useful one not
 * yet answered: the medicines, then health conditions, then age, then whether they live alone. Never more than
 * one an answer, never on a day with a warning, an emergency or a home that is not safe, never again for a week
 * once asked, and a "no" is kept so it is never asked again. The answer goes to about_me like anything else.
 *   https://arxiv.org/pdf/2403.02421
 *
 * How each is worded follows Amazon's rules for Alexa+ add-ons and its voice design guide:
 *   - Say why before asking, and never more than that: health details are sensitive personal information, which
 *     needs a clear purpose and consent ("identify what you need, disclose why, and never exceed the stated scope").
 *   - The question itself comes last, because the microphone opens when Alexa stops talking, and it is a yes or no
 *     question, or one with a short answer, never an open one.
 *   - Age can be declined, and is asked of the person speaking, never of a child.
 *   - Once medicines are known, they are asked whether those may be named out loud, since an add-on must not recite
 *     private information by voice where others may hear.
 *   https://developer.amazon.com/en-US/docs/alexa/alexaplus/add-ons/policy-requirements.html
 *   https://developer.amazon.com/en-US/docs/alexa/alexaplus/add-ons/functional-requirements.html
 *   https://developer.amazon.com/en-US/docs/alexa/alexa-design/get-started.html
 */

export type SetupKey = 'medicines' | 'aloud' | 'conditions' | 'age' | 'alone';

type Person = {
  lat: number | null;
  medications: unknown[];
  /** Medicines named but not in the heat list, kept to watch for recalls. They were still given. */
  recallWatch?: string[];
  conditions: string[];
  livesAlone?: boolean;
  age?: number;
  noMedicines?: boolean;
  noConditions?: boolean;
  privacy?: boolean;
  privacyChosen?: boolean;
  setupAsked?: Partial<Record<SetupKey, string>>;
};

const WEEK_MS = 7 * 86_400_000;

export const QUESTIONS: Record<SetupKey, string> = {
  medicines: "Some medicines change what the heat and the cold do to your body. I'd use yours only to warn you, until you tell me to forget them. Do you take any medicines?",
  aloud: 'When I warn you about a medicine, I can say its name, or just say one of your medicines, in case somebody else can hear. Should I say the names?',
  conditions: "Heart disease, diabetes, asthma and some other conditions change my answer too, and I'd use them only for that. Do you have any health conditions?",
  age: "Past 65, the heat and the cold are both harder on the body. You don't have to say, but how old are you?",
  alone: 'If you live on your own, I can ask somebody you trust to check on you on a dangerous day. Do you live on your own?',
};

/** The one question to ask now, or null. `today` is the person's own date; nothing here is saved. */
export function nextQuestion(p: Person, now = Date.now()): { key: SetupKey; ask: string } | null {
  if (p.lat == null) return null;
  const recently = (k: SetupKey) => {
    const at = p.setupAsked?.[k];
    return !!at && now - Date.parse(at) < WEEK_MS;
  };
  const open: SetupKey[] = [];
  // Somebody who named a medicine has answered, even when it is one the heat list does not hold, like insulin.
  if (!p.medications.length && !p.recallWatch?.length && !p.noMedicines) open.push('medicines');
  // Asked once there are names to say, unless they have already asked for privacy.
  if (p.medications.length && !p.privacyChosen && !p.privacy) open.push('aloud');
  if (!p.conditions.length && !p.noConditions) open.push('conditions');
  if (p.age == null && !p.conditions.includes('older_adult')) open.push('age');
  if (p.livesAlone === undefined) open.push('alone');
  // One a day at most, whichever was asked last.
  const last = Math.max(0, ...Object.values(p.setupAsked ?? {}).map((d) => Date.parse(d ?? '') || 0));
  if (now - last < 86_400_000) return null;
  const key = open.find((k) => !recently(k));
  return key ? { key, ask: QUESTIONS[key] } : null;
}
