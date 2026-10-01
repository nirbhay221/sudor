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

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

export type Email = { to: string; subject: string; text: string; reason: string };
export type Delivery = {
  at: string;
  to: string;
  subject: string;
  reason: string;
  status: 'sent' | 'not_configured' | 'failed';
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

function record(d: Delivery): Delivery {
  recent.push(d);
  if (recent.length > 200) recent.shift();
  mkdirSync(dirname(OUTBOX), { recursive: true });
  appendFileSync(OUTBOX, `${JSON.stringify(d)}\n`);
  return d;
}

/** Whether this server can actually send, so spoken answers never overclaim. */
export const emailConfigured = (): boolean => Boolean(from);

export async function sendEmail(email: Email): Promise<Delivery> {
  const base = { at: new Date().toISOString(), to: email.to, subject: email.subject, reason: email.reason };
  if (!from) return record({ ...base, status: 'not_configured' });
  try {
    await transport(email, from);
    return record({ ...base, status: 'sent' });
  } catch (err) {
    return record({ ...base, status: 'failed', detail: err instanceof Error ? err.message : String(err) });
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

/** What is said to a sandbox visitor who tries. Spoken aloud, so plain words. */
export const DEMO_NO_EMAIL = 'Email is turned off in the public demo, so I have not sent anything. A linked account can use it.';
