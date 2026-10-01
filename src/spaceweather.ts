/**
 * Sudor as an MCP client.
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
 * Orbita does, and it is an MCP server, so Sudor talks to it the way any host
 * would: it opens a Streamable HTTP client, calls the public `storm_status`
 * tool, and reads the NOAA scale out of the answer.
 *
 * Two rules make this safe to do.
 *
 * Nothing personal goes the other way. The call carries no arguments at all, no
 * location, no medicines, no identifier. Orbita learns that somebody asked what
 * the sun is doing, which is already public. Health data never leaves this
 * process, and no amount of convenience is worth changing that.
 *
 * And a quiet failure is silence, never an all clear. If Orbita is unreachable,
 * or slow, or answers with something unexpected, this reports nothing and Sudor
 * says nothing about space weather. Telling someone on home oxygen that the grid
 * looks fine, because a request timed out, would be the worst thing here.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { backoff } from './backoff.js';

export type Outlook = {
  /** NOAA G scale, 0 to 5, the worst of today and the three day outlook. */
  g: number;
  /** When that level is expected: today, or the date from the outlook. */
  when: string;
  /** The highest Kp in the forecast, when the answer carried one. */
  peakKp: number | null;
  fetchedAt: number;
};

const URL = process.env.SUDOR_ORBITA_URL ?? '';
const EVERY_MS = 30 * 60 * 1000;
const STALE_MS = 3 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;

let held: Outlook | null = null;
let ask: () => Promise<Outlook | null> = askOrbita;

/** Whether this server has been pointed at an Orbita to ask. */
export const configured = (): boolean => URL.length > 0 || ask !== askOrbita;

/**
 * One call to Orbita, over MCP, with no arguments and a short fuse.
 *
 * The transport is opened and closed per poll rather than held open. This runs
 * twice an hour, the endpoint is stateless, and a connection that lives for
 * weeks is a connection that fails in ways nobody tests for.
 */
async function askOrbita(): Promise<Outlook | null> {
  if (!URL) return null;
  const client = new Client({ name: 'sudor', version: '0.1.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new globalThis.URL(`${URL}/mcp`));
  const cutOff = setTimeout(() => void transport.close().catch(() => {}), TIMEOUT_MS);
  try {
    await client.connect(transport);
    const result = (await client.callTool({ name: 'storm_status', arguments: {} })) as {
      structuredContent?: {
        scales?: { g?: number; days?: { date?: string; g?: number | null }[] };
        peak?: { kp?: number } | null;
      };
    };
    const scales = result.structuredContent?.scales;
    if (!scales) return null;

    const today = Number(scales.g ?? 0);
    const ahead = (scales.days ?? []).filter((d) => typeof d?.g === 'number');
    const worstAhead = ahead.reduce<{ date: string; g: number } | null>(
      (worst, d) => (worst && worst.g >= Number(d.g) ? worst : { date: String(d.date ?? ''), g: Number(d.g) }),
      null,
    );

    const g = Math.max(today, worstAhead?.g ?? 0);
    const when = worstAhead && worstAhead.g > today ? worstAhead.date : 'today';
    const peakKp = typeof result.structuredContent?.peak?.kp === 'number' ? result.structuredContent.peak.kp : null;
    return { g, when, peakKp, fetchedAt: Date.now() };
  } catch (err) {
    // Unreachable, slow, or answering something this does not understand. All
    // three mean the same thing to a customer, silence, but an operator reading
    // the log should be able to tell which it was.
    console.error('[spaceweather] could not reach the space weather server:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(cutOff);
    try {
      await client.close();
    } catch {
      /* already gone */
    }
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
 * one just answers whether the link to Orbita is alive.
 */
export const lastSeen = (): Outlook | null => held;

export function speak(o: Outlook): string {
  const day = o.when === 'today' ? 'today' : `on ${o.when}`;
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

/** For tests, and for running without an Orbita to ask. */
export function configureForTest(fake: (() => Promise<Outlook | null>) | null): void {
  ask = fake ?? askOrbita;
  held = null;
}

export function seedForTest(o: Outlook | null): void {
  held = o;
}
