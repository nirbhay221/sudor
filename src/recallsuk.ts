/**
 * Recalls in the United Kingdom.
 *
 * The MHRA publishes its drug and device alerts on GOV.UK, and GOV.UK's own search API returns them as data,
 * free and without a key, under the Open Government Licence. For somebody in the UK, their medicines are matched
 * against the titles and summaries of medicines recalls and drug alerts from the last three years. A recall is of
 * particular batches, so the answer says to check the batch and never to stop a medicine.
 *
 * Source: https://www.gov.uk/drug-device-alerts
 */

const API = 'https://www.gov.uk/api/search.json?filter_content_store_document_type=medical_safety_alert&count=500&fields=title,public_timestamp,description,link&order=-public_timestamp';
const EVERY_MS = 12 * 60 * 60 * 1000;
const THREE_YEARS = 3 * 365 * 24 * 60 * 60 * 1000;

export type UkAlert = { title: string; description: string; at: string; link: string };
let held: { at: number; rows: UkAlert[] } | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function parse(body: unknown, now = Date.now()): UkAlert[] {
  const results = (body as { results?: Record<string, unknown>[] } | null)?.results;
  if (!Array.isArray(results)) throw new Error('gov.uk: no results');
  return results
    .map((r) => ({ title: String(r.title ?? ''), description: String(r.description ?? ''), at: String(r.public_timestamp ?? ''), link: `https://www.gov.uk${String(r.link ?? '')}` }))
    .filter((r) => /recall|drug alert|medicines/i.test(r.title) && now - Date.parse(r.at) < THREE_YEARS);
}

export async function refresh(): Promise<void> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(API, { signal: ctrl.signal, headers: { 'User-Agent': 'sudor-mcp (github.com/nirbhay221/sudor)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    held = { at: Date.now(), rows: parse(await res.json()) };
  } catch {
    // Keep the last list. A failed check is not an all-clear.
  } finally {
    clearTimeout(t);
  }
}

export function start(): void {
  if (timer) return;
  void refresh();
  timer = setInterval(() => void refresh(), EVERY_MS);
  timer.unref?.();
}

const words = (s: string): string => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;

/** Alerts naming any of these medicines, newest first. Null when the list has not been read yet. */
export function forMedicines(generics: string[]): UkAlert[] | null {
  if (!held) return null;
  const names = generics.map((g) => g.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).filter((g) => g.length >= 4);
  return held.rows.filter((r) => names.some((n) => words(`${r.title} ${r.description}`).includes(` ${n} `)));
}

export function speak(a: UkAlert): string {
  const klass = /class 1/i.test(a.title) ? 'a Class 1 recall, the most serious' : /class 2/i.test(a.title) ? 'a Class 2 recall' : /class 3/i.test(a.title) ? 'a Class 3 recall' : 'an alert';
  const what = a.title.replace(/^class \d (medicines recall|drug alert)s?:\s*/i, '').replace(/,?\s*EL\s*\(.*$/, '');
  return `The MHRA has ${klass}: ${what}. Check the batch number on your pack against the notice, and don't stop taking it without asking your pharmacist.`;
}

export function seedForTest(rows: UkAlert[] | null): void {
  held = rows ? { at: Date.now(), rows } : null;
}
