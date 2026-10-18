/**
 * Telling a person, not just answering one.
 *
 * An Alexa+ add-on cannot make an Echo speak first. A server can still send an
 * email, and that is how a caregiver hears about a heat emergency, or about a
 * day that is dangerous for someone they look after. Two rules hold everywhere
 * this is used: nobody is contacted until they have been confirmed, and nothing
 * spoken claims a message was delivered when it was only attempted.
 *
 * Email goes through Amazon SES once SUDOR_EMAIL_FROM is set to a verified
 * sender. Until then every message is still written to the outbox file and
 * marked not_configured, so a demo never pretends. While an SES account is in
 * the sandbox, each recipient address has to be verified as well.
 */

import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

export type Email = { to: string; subject: string; text: string; reason: string; /** Whose account asked for it, for the per-sender limit. */ sender?: string };
export type Delivery = {
  at: string;
  to: string;
  subject: string;
  reason: string;
  status: 'sent' | 'not_configured' | 'failed' | 'limited' | 'unverified';
  detail?: string;
};
type Transport = (email: Email, from: string) => Promise<void>;

const OUTBOX = resolve(process.env.SUDOR_OUTBOX ?? './data/outbox.jsonl');
let from: string | undefined = process.env.SUDOR_EMAIL_FROM;
let client: SESv2Client | null = null;

let transport: Transport = async (email, sender) => {
  client ??= new SESv2Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
  await client.send(
    new SendEmailCommand({
      FromEmailAddress: sender,
      Destination: { ToAddresses: [email.to] },
      Content: { Simple: { Subject: { Data: email.subject }, Body: { Text: { Data: email.text } } } },
    }),
  );
};

const recent: Delivery[] = [];

/**
 * The outbox is a log of what was attempted, kept so a demo can show that nothing was pretended.
 *
 * It used to hold the recipient's address and the subject line in the clear, next to a data file that is
 * encrypted precisely because it holds those addresses, and it grew for ever. It now records a short hash of
 * the address, which is enough to tell two recipients apart and not enough to email one, drops the subject,
 * and starts a new file at one megabyte, keeping one old one.
 */
const OUTBOX_MAX_BYTES = 1024 * 1024;
const addressTag = (to: string) => createHash('sha256').update(to.toLowerCase()).digest('hex').slice(0, 12);

function record(d: Delivery): Delivery {
  recent.push(d);
  if (recent.length > 200) recent.shift();
  try {
    mkdirSync(dirname(OUTBOX), { recursive: true });
    try {
      if (statSync(OUTBOX).size > OUTBOX_MAX_BYTES) renameSync(OUTBOX, `${OUTBOX}.1`);
    } catch {
      /* no outbox yet */
    }
    const line = { at: d.at, to: addressTag(d.to), reason: d.reason, status: d.status, ...(d.detail ? { detail: d.detail } : {}) };
    appendFileSync(OUTBOX, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch (err) {
    // A full disk or a read-only directory must not be the reason an email was not sent.
    console.error('[notify] could not write the outbox:', err instanceof Error ? err.message : err);
  }
  return d;
}

/** Whether this server can actually send, so spoken answers never overclaim. */
export const emailConfigured = (): boolean => Boolean(from);

/**
 * How much mail one sender, and one recipient, can be sent.
 *
 * A contact is confirmed by the account holder, not by the person who owns the address, so "confirmed" does
 * not mean the recipient agreed. Without a ceiling, a linked account could add any address, confirm it
 * itself, and then ask for a report again and again: an email bomb with this server's name on it, and the
 * fastest way to lose an SES sending reputation. So every send is counted twice, against the recipient and
 * against the sender, and refused past the limit. An emergency is counted on its own, shorter clock, so a
 * day of ordinary mail can never be the reason a heat stroke alert was not sent.
 *
 * Held in memory, so a restart forgets the counts. The limits are small enough that this does not matter.
 */
/** An invitation is one email asking a stranger whether they agree, so it is the tightest of all: one a day per address. */
const invitedTo = new Map<string, number[]>();
const PER_RECIPIENT_PER_DAY = Number(process.env.SUDOR_EMAILS_PER_RECIPIENT ?? 8);
const PER_SENDER_PER_DAY = Number(process.env.SUDOR_EMAILS_PER_SENDER ?? 30);
const URGENT_PER_HOUR = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const sentTo = new Map<string, number[]>();
const sentBy = new Map<string, number[]>();
const urgentTo = new Map<string, number[]>();
/** A heat stroke alert and a person asking for help. Neither waits behind a day of ordinary mail. */
const urgent = (reason: string): boolean => reason === 'emergency' || reason === 'help';

function within(map: Map<string, number[]>, key: string, windowMs: number, now: number): number[] {
  const kept = (map.get(key) ?? []).filter((t) => now - t < windowMs);
  if (kept.length) map.set(key, kept);
  else map.delete(key);
  return kept;
}

/** Whether this message may be sent now, without counting it. */
export function withinEmailLimits(email: Pick<Email, 'to' | 'reason' | 'sender'>, now = Date.now()): boolean {
  const to = email.to.toLowerCase();
  if (urgent(email.reason)) return within(urgentTo, to, HOUR_MS, now).length < URGENT_PER_HOUR;
  if (email.reason === 'invite' && within(invitedTo, to, DAY_MS, now).length >= 1) return false;
  if (within(sentTo, to, DAY_MS, now).length >= PER_RECIPIENT_PER_DAY) return false;
  if (email.sender && within(sentBy, email.sender, DAY_MS, now).length >= PER_SENDER_PER_DAY) return false;
  return true;
}

function count(email: Email, now = Date.now()): void {
  const to = email.to.toLowerCase();
  if (urgent(email.reason)) {
    urgentTo.set(to, [...within(urgentTo, to, HOUR_MS, now), now]);
    return;
  }
  if (email.reason === 'invite') invitedTo.set(to, [...within(invitedTo, to, DAY_MS, now), now]);
  sentTo.set(to, [...within(sentTo, to, DAY_MS, now), now]);
  if (email.sender) sentBy.set(email.sender, [...within(sentBy, email.sender, DAY_MS, now), now]);
  // An address book of strangers is the abuse this exists for, so the books themselves are bounded.
  for (const map of [sentTo, sentBy]) if (map.size > 20_000) map.delete(map.keys().next().value as string);
}

export function resetEmailLimitsForTest(): void {
  sentTo.clear();
  invitedTo.clear();
  sentBy.clear();
  urgentTo.clear();
}

export async function sendEmail(email: Email): Promise<Delivery> {
  const base = { at: new Date().toISOString(), to: email.to, subject: email.subject, reason: email.reason };
  if (!from) return record({ ...base, status: 'not_configured' });
  if (!withinEmailLimits(email)) return record({ ...base, status: 'limited' });
  count(email);
  try {
    await transport(email, from);
    return record({ ...base, status: 'sent' });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // In the SES sandbox an address nobody has verified is refused. That is the account's setting, not a broken
    // send, so it is kept apart from failures and does not make the scheduled check report itself failed.
    const unverified = (err as { name?: string })?.name === 'MessageRejected' && /not verified/i.test(detail);
    return record({ ...base, status: unverified ? 'unverified' : 'failed', detail });
  }
}

export const recentDeliveries = (): Delivery[] => [...recent];

/** Test seam: a sender address and a fake transport, so tests never touch SES. */
export function configureForTest(opts: { from?: string; transport?: Transport }): void {
  from = opts.from;
  if (opts.transport) transport = opts.transport;
}

/**
 * Whether this identity may cause an email to be sent.
 *
 * Never a sandbox. A demo visitor can add any address as a contact, confirm it
 * themselves (the confirmation is on the caller's side, not the recipient's), and
 * then trigger an alert whose text they wrote, so without this the server is a relay
 * for sending attacker-chosen words to an arbitrary inbox from this operator's own
 * domain. SES sandbox mode, which only delivers to verified addresses, is the only
 * thing that has been standing between the demo and that, and it is a setting
 * somebody changes the day they ask for production access.
 *
 * Checked where the send is decided, by identity, rather than in the transport: the
 * transport has no idea who asked.
 */
export const canEmailFor = (id: string): boolean => !id.startsWith('demo:');

/**
 * The phone on the demo page.
 *
 * A visitor to the public demo can never cause an email, for the reason above. But a demo in which the
 * family's half is a sentence saying "nothing was sent" shows nobody what the product does. So for a sandbox
 * identity, the message that would have been emailed is put, word for word, where only that visitor can read
 * it: a list held in memory against their own sandbox id, which the demo page shows as a phone. Nothing
 * leaves the server, nobody else can read it, and the links in it are the real ones, so agreeing, answering
 * and stopping all work exactly as they do from an inbox.
 */
export type PhoneMessage = { at: string; to: string; subject: string; text: string; reason: string; accept?: string; reply?: string; stop?: string };
const phones = new Map<string, PhoneMessage[]>();
const MAX_PHONES = 2000;
const MAX_ON_PHONE = 30;

export function toDemoPhone(personId: string, message: Omit<PhoneMessage, 'at'>): void {
  if (canEmailFor(personId)) return;
  const list = phones.get(personId) ?? [];
  list.push({ at: new Date().toISOString(), ...message, text: message.text.slice(0, 4000) });
  phones.delete(personId);
  phones.set(personId, list.slice(-MAX_ON_PHONE));
  if (phones.size > MAX_PHONES) phones.delete(phones.keys().next().value as string);
}

export const demoPhone = (personId: string): PhoneMessage[] => [...(phones.get(personId) ?? [])];

/** Said in place of "I'm emailing them" to a sandbox visitor. */
export const DEMO_PHONE = 'In this demo that goes to the phone on this page, not to a real inbox.';

/** What is said to a sandbox visitor who tries. Spoken aloud, so plain words. */
export const DEMO_NO_EMAIL = 'Email is turned off in the public demo, so I have not sent anything. A linked account can use it.';
