/**
 * A text message, for the messages that cannot wait in an inbox.
 *
 * Email is how a family is told about a hot day tomorrow. It is a poor way to be told that somebody has
 * described heat stroke. Two other entries in this hackathon, Kinhaven and CarePulse, text the family
 * through Amazon SNS, and this does the same, with the same consent rule as everything else here: the
 * person who owns the phone adds the number themselves, on the page where they agree to the emails. The
 * account holder never types somebody else's mobile number.
 *
 * Only the urgent messages are texted: an emergency described, a call for help, "I'm safe", and an
 * official warning starting where they live. Each is short and carries nothing about health.
 *
 * Switched on with SUDOR_SMS=on, and needs sns:Publish for the server's role. While the AWS account's SMS
 * is in its sandbox, only numbers verified in the SNS console receive anything; sending to any US number
 * needs a registered origination number, which Amazon approves separately.
 */

import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { canEmailFor } from './notify.js';

export type Text = { to: string; text: string; reason: 'emergency' | 'help' | 'safe' | 'warning'; sender: string };
export type TextDelivery = { at: string; to: string; reason: string; status: 'sent' | 'off' | 'limited' | 'failed'; detail?: string };

/** E.164: a plus, a country code and the number. "(602) 555-0100" becomes "+16025550100". */
export function phoneOf(typed: string): string | null {
  const t = typed.trim();
  if (!t) return null;
  const digits = t.replace(/[^\d]/g, '');
  if (t.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** The last four digits only, for anything spoken or logged. */
export const masked = (phone: string): string => `ending ${phone.slice(-4)}`;

export const textsOn = (): boolean => (process.env.SUDOR_SMS ?? '').toLowerCase() === 'on';

type Transport = (t: Text) => Promise<void>;
let client: SNSClient | null = null;
let transport: Transport = async (t) => {
  client ??= new SNSClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  await client.send(
    new PublishCommand({
      PhoneNumber: t.to,
      Message: t.text.slice(0, 300),
      MessageAttributes: { 'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' } },
    }),
  );
};

/** At most three texts to one number in an hour, whatever the reason. A text costs money and wakes people. */
const sent = new Map<string, number[]>();
const HOUR = 3_600_000;
function allowed(to: string, now = Date.now()): boolean {
  const recent = (sent.get(to) ?? []).filter((t) => now - t < HOUR);
  if (recent.length >= 3) return false;
  sent.set(to, [...recent, now]);
  if (sent.size > 5000) sent.delete(sent.keys().next().value as string);
  return true;
}

const log: TextDelivery[] = [];
export const recentTexts = (): TextDelivery[] => [...log];
const record = (d: TextDelivery): TextDelivery => {
  log.push({ ...d, to: masked(d.to) });
  if (log.length > 100) log.shift();
  return d;
};

export async function sendText(t: Text): Promise<TextDelivery> {
  const base = { at: new Date().toISOString(), to: t.to, reason: t.reason };
  // Never from a sandbox identity, for the same reason as email: see canEmailFor in notify.ts.
  if (!textsOn() || !canEmailFor(t.sender)) return record({ ...base, status: 'off' });
  if (!allowed(t.to)) return record({ ...base, status: 'limited' });
  try {
    await transport(t);
    return record({ ...base, status: 'sent' });
  } catch (err) {
    return record({ ...base, status: 'failed', detail: err instanceof Error ? err.message : String(err) });
  }
}

export function configureForTest(fn: Transport | null): void {
  if (fn) transport = fn;
  sent.clear();
}
