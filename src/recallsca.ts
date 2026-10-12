/**
 * Recalls in Canada.
 *
 * openFDA (recalls.ts) is the United States list. Health Canada publishes its own recalls and safety alerts as
 * open data, refreshed daily, under the Open Government Licence - Canada: drugs, natural health products and
 * medical devices among them. For somebody whose place is in Canada, their medicines are matched against the
 * drug and natural health product recalls, by the generic name in the recall's title or product. Archived
 * recalls and anything older than three years are left out. As with the FDA list, a recall covers particular
 * lots, so the answer says to check the lot and never to stop a medicine.
 *
 * Source: https://open.canada.ca/data/en/dataset/d38de914-c94c-429b-8ab1-8776c31643e3
 */

const URL = 'https://recalls-rappels.canada.ca/sites/default/files/opendata-donneesouvertes/HCRSAMOpenData.json';
const EVERY_MS = 24 * 60 * 60 * 1000;
const THREE_YEARS = 3 * 365 * 24 * 60 * 60 * 1000;

export type CaRecall = { title: string; product: string; recallClass: string; updated: string; url: string };
let held: { at: number; rows: CaRecall[] } | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function parse(body: unknown, now = Date.now()): CaRecall[] {
  if (!Array.isArray(body)) throw new Error('health canada: not a list');
  return (body as Record<string, unknown>[])
    .filter((r) => (r.Category === 'Drugs' || r.Category === 'Natural health products') && String(r.Archived ?? '0') !== '1')
    .filter((r) => {
      const t = Date.parse(String(r['Last updated'] ?? ''));
      return Number.isFinite(t) && now - t < THREE_YEARS;
    })
    .map((r) => ({
      title: String(r.Title ?? '').trim(),
      product: String(r.Product ?? '').trim(),
      recallClass: String(r['Recall class'] ?? ''),
      updated: String(r['Last updated'] ?? ''),
      url: String(r.URL ?? ''),
    }));
}

export async function refresh(): Promise<void> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(URL, { signal: ctrl.signal, headers: { 'User-Agent': 'sudor-mcp (github.com/nirbhay221/sudor)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = (await res.text()).replace(/^\uFEFF/, '');
    held = { at: Date.now(), rows: parse(JSON.parse(text)) };
  } catch {
    // Keep the last list. A failed check is not an all-clear, and with nothing held the answer says so.
  } finally {
    clearTimeout(t);
  }
}

/** Follow the list once a day. Started only when somebody's place is in Canada. */
export function start(): void {
  if (timer) return;
  void refresh();
  timer = setInterval(() => void refresh(), EVERY_MS);
  timer.unref?.();
}

/** Recalls naming any of these medicines, newest first. Null when the list has not been read yet. */
export function forMedicines(generics: string[]): CaRecall[] | null {
  if (!held) return null;
  const words = generics.map((g) => g.toLowerCase()).filter((g) => g.length >= 4);
  return held.rows
    .filter((r) => words.some((w) => ` ${`${r.title} ${r.product}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `.includes(` ${w.replace(/[^a-z0-9]+/g, ' ').trim()} `)))
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

export function speak(r: CaRecall): string {
  const klass = /type i\b|type 1/i.test(r.recallClass) ? 'a Type one recall, the most serious' : r.recallClass ? `a ${r.recallClass} recall` : 'a recall';
  return `Health Canada has ${klass}: ${r.title.replace(/\.$/, '')}. Check the lot number on your package against the notice, and don't stop taking it without asking your pharmacist.`;
}

export function seedForTest(rows: CaRecall[] | null): void {
  held = rows ? { at: Date.now(), rows } : null;
}
