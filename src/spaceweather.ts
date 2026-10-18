/**
 * The sun, read straight from NOAA.
 *
 * A severe geomagnetic storm is a power problem before it is anything else.
 * NOAA's own G-scale says a G4 can bring "possible widespread voltage control
 * problems" and that at G5 "some grid systems may experience complete collapse
 * or blackouts" (https://www.swpc.noaa.gov/noaa-scales-explanation). Sudor
 * already knows what a power cut means for a person: insulin that has to stay
 * between 36 and 46 degrees, a dialysis chair that needs a working clinic, an
 * oxygen concentrator that needs a socket. What it could not see was a storm
 * coming, because the National Weather Service does not forecast space weather.
 *
 * NOAA's Space Weather Prediction Center does, in two public files with no key:
 * noaa-scales.json, today's G level and the three day outlook, and
 * noaa-planetary-k-index-forecast.json, Kp in three hour blocks. This reads both
 * twice an hour. It used to ask another MCP server for the same numbers, which
 * was one more thing to be down; NOAA is the source either way.
 *
 * Two rules make this safe to do.
 *
 * Nothing personal goes the other way. The requests are two fixed URLs with no
 * query at all, no location, no medicines, no identifier.
 *
 * And a quiet failure is silence, never an all clear. If NOAA is unreachable,
 * or slow, or answers with something unexpected, this reports nothing and Sudor
 * says nothing about space weather. Telling someone on home oxygen that the grid
 * looks fine, because a request timed out, would be the worst thing here.
 */

import { backoff } from './backoff.js';

export type Outlook = {
  /** NOAA G scale, 0 to 5, the worst of today and the three day outlook. */
  g: number;
  /** When that level is expected: today, or the date from the outlook. */
  when: string;
  /** The highest Kp in the forecast still to come, when the Kp file answered. */
  peakKp: number | null;
  fetchedAt: number;
};

/** Where NOAA's files are. A setting only so the tests can stand in for NOAA. */
const BASE = process.env.SUDOR_SWPC_BASE ?? 'https://services.swpc.noaa.gov/products';
const EVERY_MS = 30 * 60 * 1000;
const STALE_MS = 3 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;

let held: Outlook | null = null;
let ask: () => Promise<Outlook | null> = askNoaa;

/** On unless SUDOR_SPACE_WEATHER=off. */
export const configured = (): boolean => (process.env.SUDOR_SPACE_WEATHER ?? '').toLowerCase() !== 'off' || ask !== askNoaa;

async function getJson(file: string): Promise<unknown> {
  const res = await fetch(`${BASE}/${file}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return res.json();
}

const level = (v: unknown): number | null =>
  v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.min(5, Number(v)));

/**
 * One read of each file, with a short fuse. The scales are the answer; the Kp
 * peak is extra, so the Kp file failing costs only the peak.
 */
async function askNoaa(): Promise<Outlook | null> {
  try {
    const [scalesRaw, kpRaw] = await Promise.all([
      getJson('noaa-scales.json'),
      getJson('noaa-planetary-k-index-forecast.json').catch(() => null),
    ]);
    // Key "0" is today, "-1" yesterday, "1" to "3" the outlook.
    const sc = scalesRaw as Record<string, { DateStamp?: string; G?: { Scale?: string | null } }> | null;
    if (!sc || typeof sc !== 'object' || !sc['0']) return null;

    const today = level(sc['0'].G?.Scale) ?? 0;
    const worstAhead = ['1', '2', '3']
      .map((k) => ({ date: String(sc[k]?.DateStamp ?? ''), g: level(sc[k]?.G?.Scale) }))
      .filter((d): d is { date: string; g: number } => d.g != null)
      .reduce<{ date: string; g: number } | null>((worst, d) => (worst && worst.g >= d.g ? worst : d), null);

    const g = Math.max(today, worstAhead?.g ?? 0);
    const when = worstAhead && worstAhead.g > today ? worstAhead.date : 'today';

    // The Kp file carries the past week too, so the peak comes only from blocks not yet over.
    let peakKp: number | null = null;
    if (Array.isArray(kpRaw)) {
      for (const r of kpRaw as { time_tag?: string; kp?: number | string }[]) {
        const start = Date.parse(`${String(r?.time_tag ?? '').replace(/Z$/, '')}Z`);
        const kp = Number(r?.kp);
        if (!Number.isFinite(start) || r?.kp == null || !Number.isFinite(kp)) continue;
        if (start + 3 * 3_600_000 > Date.now() && (peakKp == null || kp > peakKp)) peakKp = kp;
      }
    }
    return { g, when, peakKp, fetchedAt: Date.now() };
  } catch (err) {
    // Unreachable, slow, or answering something this does not understand. All
    // three mean the same thing to a customer, silence, but an operator reading
    // the log should be able to tell which it was.
    console.error('[spaceweather] could not read the NOAA space weather feed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** After a run of failures, stop asking a server that is not answering. See backoff.ts. */
const gate = backoff();

async function poll(): Promise<void> {
  if (!gate.ready()) return;
  const fresh = await ask();
  if (fresh) gate.ok();
  else gate.fail();
  if (fresh) held = fresh;
  else if (held && Date.now() - held.fetchedAt > STALE_MS) held = null;
}

export async function start(): Promise<void> {
  if (!configured()) return;
  await poll();
  const timer = setInterval(() => void poll(), EVERY_MS);
  timer.unref?.();
}

/**
 * What to say about it, or nothing at all.
 *
 * Below G4 this stays quiet, and the bar started at G3 until the history was
 * checked properly. G3's grid line in the NOAA scale is "voltage corrections
 * may be required, false alarms triggered on some protection devices", which is
 * a control room's afternoon, not a household's. Saying anything to someone on
 * home oxygen at that level is noise, and noise is how a line that matters gets
 * ignored.
 *
 * Even at G4 and G5 the honest base rate is that nothing happens. Since the
 * Quebec collapse in March 1989 there has been one small regional outage from a
 * geomagnetic storm in the developed world, Malmo in October 2003, and North
 * America has come through every storm since with the lights on, including the
 * G5 of May 2024 where the grid held across three days of G3 to G5 conditions.
 * GMD planning has been a mandatory NERC standard since 2016. So this is said
 * as a nudge to charge things, never as a forecast about anyone's street.
 */
export function outlook(): Outlook | null {
  if (!held) return null;
  if (Date.now() - held.fetchedAt > STALE_MS) return null;
  return held.g >= 4 ? held : null;
}

/**
 * What the last successful poll saw, whatever its level, for /health and for
 * probes. outlook() is the one that decides whether it is worth saying; this
 * one just answers whether the NOAA feed is being read.
 */
export const lastSeen = (): Outlook | null => held;

export function speak(o: Outlook): string {
  // A date is said as a day, not read out as 2026-10-06.
  const at = new Date(`${o.when}T12:00:00Z`);
  const day =
    o.when === 'today'
      ? 'today'
      : Number.isNaN(at.getTime())
        ? 'in the next few days'
        : `on ${at.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })}`;
  // The G5 line names the one real case, because at G5 someone will have read
  // a headline about it, and the specific answer is better than a reassurance.
  const record =
    o.g >= 5
      ? 'A storm that size has taken a grid down once, in Quebec in 1989, on older equipment. The last G5 over North America, in May 2024, passed with the lights on.'
      : 'No storm that size has ever taken down a grid here, including the bigger one in May 2024.';
  return (
    `One more thing: NOAA has a G${o.g} geomagnetic storm forecast ${day}. ${record} ` +
    'So this is not a warning that you will lose power. It is only worth a mention because some of ' +
    'what you rely on needs electricity, and charging it costs you nothing today.'
  );
}

/** For tests: a stand-in for NOAA, or null for the real one. */
export function configureForTest(fake: (() => Promise<Outlook | null>) | null): void {
  ask = fake ?? askNoaa;
  held = null;
}

export function seedForTest(o: Outlook | null): void {
  held = o;
}
