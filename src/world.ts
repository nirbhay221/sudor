/**
 * Outside the United States.
 *
 * Alexa+ is sold in the United States, but the people it serves travel, and their families do not all live
 * there. The weather, air quality and medicine classes Sudor uses are already worldwide. What was American
 * is the emergency number, the warnings and the shelter list, and this is what replaces each.
 *
 * The emergency number. What somebody is told to ring when heat stroke is described has to be the number
 * that works where they are. These are the numbers for an ambulance, or the general number where that is
 * what is used, from the national lists collected at Wikipedia's "List of emergency telephone numbers".
 * Anywhere not listed is told 112, which every GSM mobile phone network is required to connect, and the
 * local number, both.
 *
 * Source: https://en.wikipedia.org/wiki/List_of_emergency_telephone_numbers
 */

const EU_112 = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT',
  'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'CH', 'IS', 'LI', 'TR', 'RU', 'UA', 'IN', 'ZA', 'NG',
];

const NUMBER: Record<string, string> = {
  US: '911', CA: '911', MX: '911', PR: '911', GU: '911', PH: '911',
  GB: '999', HK: '999', AU: '000', NZ: '111', NO: '113',
  JP: '119', KR: '119', TW: '119', CN: '120', SG: '995',
  IL: '101', AE: '998', SA: '997', BR: '192', AR: '107', CL: '131', CO: '123',
  ...Object.fromEntries(EU_112.map((c) => [c, '112'])),
};

/** The number to ring for an ambulance where this person is. */
export function emergencyNumber(country: string | null | undefined): string {
  return NUMBER[(country ?? 'US').toUpperCase()] ?? '112';
}

/** Whether to say it with the 112 fallback: anywhere not in the list. */
export const known = (country: string | null | undefined): boolean => (country ?? 'US').toUpperCase() in NUMBER;

export const inUS = (country: string | null | undefined): boolean => !country || ['US', 'PR', 'GU', 'VI', 'AS', 'MP'].includes(country.toUpperCase());

/**
 * Say the right number in an answer written for the United States. "911" is the only thing changed.
 * Where the country is not in the list, it becomes "112 or your local emergency number".
 */
export function localise(text: string, country: string | null | undefined): string {
  if (inUS(country)) return text;
  text = celsius(text);
  if (emergencyNumber(country) === '911') return text;
  const n = known(country) ? emergencyNumber(country) : '112, or your local emergency number,';
  return text.replace(/\b911\b/g, n).replace(/, or your local emergency number,([.!?])/g, ', or your local emergency number$1');
}

/**
 * Celsius beside Fahrenheit, outside the United States. Everything inside Sudor is worked out in Fahrenheit
 * because the National Weather Service heat index and the US workplace limits are written in it; only what
 * is said changes. "Heat index 104" becomes "Heat index 104 (40 Celsius)", and "60 to 65 degrees" gets the
 * same. Numbers that are not temperatures (miles, minutes, percentages) are left alone.
 */
const toC = (f: number): number => Math.round(((f - 32) * 5) / 9);
export function celsius(text: string): string {
  return text
    .replace(/\b([Hh]eat index(?: (?:of|about|near))? )(-?\d{2,3})\b(?! \()/g, (_m, lead: string, f: string) => `${lead}${f} (${toC(Number(f))} Celsius)`)
    .replace(/\b(-?\d{1,3}) to (-?\d{1,3}) degrees\b(?! \()/g, (_m, a: string, b: string) => `${a} to ${b} degrees Fahrenheit (${toC(Number(a))} to ${toC(Number(b))} Celsius)`)
    .replace(/\b(-?\d{1,3}) degrees\b(?! Fahrenheit)(?! \()/g, (_m, f: string) => `${f} degrees Fahrenheit (${toC(Number(f))} Celsius)`);
}
