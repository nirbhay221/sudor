/**
 * Saying it out loud.
 *
 * Everything this add-on produces is written to be spoken, and here the listener
 * is often the reason. Someone with multiple sclerosis deciding whether to go out,
 * someone whose medication has taken their sweating away, someone reading the
 * signs of heat stroke in another person: that last one is the whole argument.
 * "If they become confused, slur their words or faint, that can be heat stroke:
 * call 911" is a sentence that has to land at the speed of speech, once, to
 * somebody frightened. Whether it does is not a thing a page of text can show.
 *
 * And the demo page renders it as text. Which means the one property the whole
 * product is designed around is the one property a judge cannot evaluate.
 *
 * Polly closes that. The same string the MCP tool returns is spoken by the same
 * class of engine Alexa uses, so a listener finds out whether a sentence actually
 * works at the speed of speech, which is a different question from whether it
 * reads well. Long numbers are where this bites: "0.7 metres, about 34 times your
 * normal 0.8 inches" is fine on a screen and is a lot to hold in your head.
 *
 * Deliberately narrow in scope. This is for the demo page and the video. It is
 * not in the MCP path, and it must never be: Alexa+ does its own speech, and a
 * server that also synthesised audio would be doing work the host has already
 * done better, and billing for it.
 *
 * Costs and how they are bounded. Polly bills per character, so the endpoint caps
 * length, refuses anything that is not plain text, and caches by content hash in
 * memory. A demo page that replays the same six canned answers therefore costs
 * six syntheses, not six per visitor. The neural voices cost roughly four times
 * the standard ones and are worth it here, because the point is to sound like the
 * device this is for.
 *
 * Absent credentials are a normal state, not an error. On the instance an IAM
 * role supplies them; on a laptop an aws login session does; in CI neither does,
 * and the endpoint says so and the page falls back to text.
 */

import { PollyClient, SynthesizeSpeechCommand, type Engine, type VoiceId } from '@aws-sdk/client-polly';
import { createHash } from 'node:crypto';

/** Off unless asked for, so nothing accidentally bills for audio. */
export const SPEAK_ON = (process.env.SUDOR_SPEAK ?? 'off').toLowerCase() === 'on';

/**
 * Joanna, neural. Chosen over the default male voice because the audience skews
 * older and the CDC's own heat materials are addressed to caregivers as often as
 * to patients; a neural voice handles the drug names far better than a standard
 * one, which matters when the sentence contains "hydrochlorothiazide".
 */
const VOICE = (process.env.SUDOR_SPEAK_VOICE ?? 'Joanna') as VoiceId;
const ENGINE = (process.env.SUDOR_SPEAK_ENGINE ?? 'neural') as Engine;

/**
 * Character ceiling.
 *
 * The longest thing this server says is a precaution list with first aid on the
 * end, which runs to a few hundred characters. Two thousand is generous for that and small enough that a
 * scripted caller cannot turn the endpoint into a bill.
 */
const MAX_CHARS = 2000;

/** Bounded so a long-lived process cannot grow without limit on audio. */
const MAX_CACHED = 64;

const cache = new Map<string, Uint8Array>();
let client: PollyClient | null = null;
const polly = () => (client ??= new PollyClient({ region: process.env.AWS_REGION ?? 'us-east-1' }));

/** Test seam, so tests never reach Polly. */
let synth: ((text: string) => Promise<Uint8Array>) | null = null;
export function configureForTest(fn: typeof synth): void {
  synth = fn;
  cache.clear();
}

export type Spoken = { audio: Uint8Array; cached: boolean; chars: number };

const key = (text: string) => createHash('sha256').update(`${VOICE}:${ENGINE}:${text}`).digest('hex');

/**
 * Reject anything that is not a sentence this server would have said.
 *
 * Not a security boundary on its own, but it keeps the endpoint from being a
 * general-purpose text-to-speech service billed to whoever is hosting it.
 */
export function usable(text: string): boolean {
  if (!text || text.length > MAX_CHARS) return false;
  // Printable ASCII plus the punctuation the phrasing actually uses. No markup,
  // no SSML: passing SSML through would let a caller change the voice, insert
  // silence, or spell out text at a different cost.
  return /^[\x20-\x7E°–\n]+$/.test(text) && !/[<>]/.test(text);
}

/** Whether this exact sentence is already held, so serving it costs nothing. */
export function isCached(text: string): boolean {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return usable(trimmed) && cache.has(key(trimmed));
}

export async function speak(text: string): Promise<Spoken> {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!usable(trimmed)) throw new Error('not speakable');

  const k = key(trimmed);
  const hit = cache.get(k);
  if (hit) return { audio: hit, cached: true, chars: trimmed.length };

  const audio = synth
    ? await synth(trimmed)
    : await (async () => {
        const out = await polly().send(
          new SynthesizeSpeechCommand({
            Text: trimmed,
            OutputFormat: 'mp3',
            VoiceId: VOICE,
            Engine: ENGINE,
          }),
        );
        if (!out.AudioStream) throw new Error('no audio returned');
        return new Uint8Array(await out.AudioStream.transformToByteArray());
      })();

  // Oldest out first. A demo replays the same handful of answers, so this holds
  // everything that matters in practice.
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
  cache.set(k, audio);
  return { audio, cached: false, chars: trimmed.length };
}

export function status(): { on: boolean; voice: string; engine: string; cached: number } {
  return { on: SPEAK_ON, voice: String(VOICE), engine: String(ENGINE), cached: cache.size };
}

export function resetForTest(): void {
  cache.clear();
  synth = null;
}
