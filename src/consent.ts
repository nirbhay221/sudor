/**
 * The person who gets the emails is the one who agrees to them.
 *
 * A contact used to be "confirmed" by the account holder saying yes. That is the account holder agreeing to
 * send, which is not the same as somebody agreeing to receive: anyone could add any address, say yes to
 * themselves, and mail a stranger from this server's name. The limits in notify.ts bound how much. This
 * closes it: the account holder's yes sends one short invitation, and nothing else is ever sent to that
 * address until the person who owns it opens the link and says yes themselves. Every email after that
 * carries a link that stops them.
 *
 * Two details that matter:
 *   - The link opens a page with a button. It does not accept on being opened, because mail scanners open
 *     every link in every email, and a scanner is not a person agreeing.
 *   - Only a hash of the invitation is stored, so reading the data file does not let anyone accept on
 *     somebody's behalf.
 *
 * It needs a public address to build the link from. Where SUDOR_PUBLIC_URL is not set, which is a developer
 * machine, there is no link to send and the holder's confirmation stands alone as it did before.
 */

import { textsOn, phoneOf } from './texts.js';
import { createHash, randomBytes } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import express from 'express';
import * as store from './store.js';
import { perCaller } from './budget.js';

export const publicUrl = (): string => (process.env.SUDOR_PUBLIC_URL ?? '').trim().replace(/\/$/, '');

/** Whether a recipient has to agree before anything is sent. Off only where there is no address to agree at, or when switched off. */
export const consentRequired = (): boolean =>
  (process.env.SUDOR_RECIPIENT_CONSENT ?? 'on').toLowerCase() !== 'off' && publicUrl() !== '';

/**
 * A sandbox visitor is always asked to agree, whether or not there is a public address, because the phone on
 * the demo page is where they agree and it is on the same page.
 */
export const alwaysAsk = (id: string): boolean => id.startsWith('demo:');

type Consenting = { confirmedAt: string | null; acceptedAt?: string | null; invitedAt?: string | null };

/** Whether this contact may be emailed an alert: the holder said yes, and so did they. */
// Anybody who was sent an invitation has to have said yes to it, wherever it was sent: an inbox, or the phone
// on the demo page, which asks even where there is no public address.
export const reachable = (c: Consenting): boolean => !!c.confirmedAt && (!!c.acceptedAt || (!consentRequired() && !c.invitedAt));

/** Confirmed by the holder and still waiting on the recipient. */
export const awaiting = (c: Consenting): boolean => !!c.confirmedAt && !c.acceptedAt && (consentRequired() || !!c.invitedAt);

const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');

export function newInvite(): { token: string; hash: string; stopId: string } {
  const token = randomBytes(24).toString('hex');
  return { token, hash: hashOf(token), stopId: randomBytes(16).toString('hex') };
}

export const acceptLink = (token: string): string => `${publicUrl()}/contact/accept?t=${token}`;
export const stopLink = (stopId: string | null | undefined): string => (stopId && publicUrl() ? `${publicUrl()}/contact/stop?s=${stopId}` : '');

/** The line every alert ends with. Empty where there is no link to give. */
export const stopFooter = (c: { stopId?: string | null }): string => {
  const link = stopLink(c.stopId);
  return link ? `\n\nTo stop these emails, open ${link}` : '';
};

/** What the invitation says. Nothing about health, and nothing about who added them beyond the name they gave. */
export function invitation(name: string, when: string, token: string): { subject: string; text: string } {
  return {
    subject: 'Do you agree to get heat and cold alerts about someone you look after?',
    text:
      `Hello ${name}. Somebody who uses Sudor, a heat and cold safety assistant, asked for you to be emailed ${when}.\n\n` +
      `Nothing more will be sent unless you agree. To agree, or to say no, open:\n${acceptLink(token)}\n\n` +
      'If you were not expecting this, do nothing. You will not hear from us again.',
  };
}

const PAGE = (title: string, body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:32rem;margin:12vh auto;padding:0 1.25rem;color:#16202e;background:#f6f7f9;line-height:1.5}
 h1{font-size:1.4rem;margin:0 0 .75rem}
 button{font:inherit;padding:.7rem 1.2rem;border-radius:.5rem;border:1px solid #16202e;background:#16202e;color:#fff;cursor:pointer;margin:.75rem .5rem 0 0}
 button.no{background:#fff;color:#16202e}
 @media (prefers-color-scheme:dark){body{background:#10151d;color:#e8ecf2}button{background:#e8ecf2;color:#10151d;border-color:#e8ecf2}button.no{background:#10151d;color:#e8ecf2}}
</style></head><body><main>${body}</main></body></html>`;

const send = (res: Response, status: number, title: string, body: string): void => {
  res.status(status);
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(PAGE(title, body));
};

const TOKEN = /^[0-9a-f]{48}$/;
const STOP = /^[0-9a-f]{32}$/;

function findByHash(hash: string): { id: string; name: string } | null {
  for (const [id, p] of store.allEntries()) {
    const c = p.contacts.find((x) => x.acceptHash === hash);
    if (c) return { id, name: c.name };
  }
  return null;
}

function findByStop(stopId: string): { id: string; name: string } | null {
  for (const [id, p] of store.allEntries()) {
    const c = p.contacts.find((x) => x.stopId === stopId);
    if (c) return { id, name: c.name };
  }
  return null;
}

/**
 * The answer coming back.
 *
 * A call for help that goes out and is never heard from again leaves the person where they started: alone,
 * and not knowing whether anybody read it. So the help email carries a link, the contact presses "I'm on my
 * way" or "Call me", and the next thing the person hears from Sudor, whatever they ask, starts with that.
 * One link per contact per call for help, good for six hours, hashed like the invitation.
 */
const REPLY_MS = 6 * 60 * 60 * 1000;
const MAX_ASKS = 20;

/** A link for one contact to answer one call for help. Returns the address to put in their email, or '' when there is nowhere to answer at. */
export function newReplyLink(personId: string, contactName: string, forDemo = false): string {
  // The demo phone lives on the same page as the server, so it needs no public address to answer at.
  if (!publicUrl() && !forDemo) return '';
  const token = randomBytes(24).toString('hex');
  store.update(personId, (p) => {
    const fresh = (p.helpAsks ?? []).filter((a) => Date.now() - new Date(a.at).getTime() < REPLY_MS);
    p.helpAsks = [...fresh, { hash: hashOf(token), contact: contactName, at: new Date().toISOString() }].slice(-MAX_ASKS);
  });
  return `${publicUrl()}/contact/reply?r=${token}`;
}

function findAsk(hash: string): { id: string; contact: string } | null {
  for (const [id, p] of store.allEntries()) {
    const a = (p.helpAsks ?? []).find((x) => x.hash === hash && Date.now() - new Date(x.at).getTime() < REPLY_MS);
    if (a) return { id, contact: a.contact };
  }
  return null;
}

/**
 * An email address, typed.
 *
 * An address is the thing a microphone gets wrong most: every letter matters and none of them is a word. So
 * when somebody says "tell my daughter Priya" and gives no address, they are handed a page to type it on.
 * A host that supports it is sent the page directly (MCP's URL-mode elicitation, which exists so that a
 * sensitive value never passes through the assistant); any other host gets the link in the answer's data for
 * a screen to show. The page stages the contact exactly as saying the address would have. Nothing is sent to
 * anybody until the person confirms, and then only an invitation.
 */
const ENTRY_MS = 15 * 60 * 1000;

export function newEntry(personId: string, name: string, relation: string | null, notifyOn: store.NotifyReason[]): string {
  const token = randomBytes(24).toString('hex');
  store.update(personId, (p) => {
    const fresh = (p.entries ?? []).filter((e) => Date.now() - new Date(e.at).getTime() < ENTRY_MS);
    p.entries = [...fresh, { hash: hashOf(token), name, relation, notifyOn, at: new Date().toISOString() }].slice(-5);
  });
  return `${publicUrl()}/contact/enter?e=${token}`;
}

function findEntry(hash: string): { id: string; entry: NonNullable<store.Person['entries']>[number] } | null {
  for (const [id, p] of store.allEntries()) {
    const entry = (p.entries ?? []).find((e) => e.hash === hash && Date.now() - new Date(e.at).getTime() < ENTRY_MS);
    if (entry) return { id, entry };
  }
  return null;
}

const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,24}$/i;

/** What was answered and not yet said aloud, as one sentence, and marks it said. Empty when there is nothing. */
export function takeReplies(personId: string): string {
  const held = store.get(personId);
  const waiting = held.helpReplies ?? [];
  const notices = held.notices ?? [];
  if (!waiting.length && !notices.length) return '';
  store.update(personId, (p) => { p.helpReplies = []; p.notices = []; });
  if (!waiting.length) return notices.join(' ');
  const coming = [...new Set(waiting.filter((r) => r.answer === 'coming').map((r) => r.from))];
  const call = [...new Set(waiting.filter((r) => r.answer === 'call').map((r) => r.from))].filter((n) => !coming.includes(n));
  const list = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
  const parts: string[] = [];
  if (coming.length) parts.push(`${list(coming)} answered: ${coming.length === 1 ? 'they are' : 'they are all'} on the way.`);
  if (call.length) parts.push(`${list(call)} answered and ${call.length === 1 ? 'asks' : 'ask'} you to ring them.`);
  return [...parts, ...notices].join(' ');
}

/** Guessing is the only way in without the email, so tries are counted per address. */
let tries = perCaller(20, 20 / 60);
/** Tests open these pages many times from one address. */
export function resetTriesForTest(): void {
  tries = perCaller(20, 20 / 60);
}
const GONE = '<h1>This link is no longer valid</h1><p>It may have been used already, or the person who added you may have removed you. Nothing will be sent to you.</p>';

export function mountConsent(app: Express): void {
  const form = express.urlencoded({ extended: false });
  const limited = (req: Request, res: Response): boolean => {
    if (tries.allow(req.ip ?? 'unknown')) return false;
    send(res, 429, 'Too many tries', '<h1>Too many tries</h1><p>Wait a few minutes and open the link again.</p>');
    return true;
  };

  app.get('/contact/accept', (req, res) => {
    if (limited(req, res)) return;
    const t = String(req.query.t ?? '');
    if (!TOKEN.test(t) || !findByHash(hashOf(t))) return send(res, 404, 'Link not valid', GONE);
    send(
      res,
      200,
      'Agree to alerts',
      '<h1>Do you agree to get these emails?</h1>' +
        '<p>Somebody who uses Sudor asked for you to be told when the heat or the cold is dangerous for them, or when they ask for help. ' +
        'You will never be sent anything about their health.</p>' +
        `<form method="post" action="/contact/accept"><input type="hidden" name="t" value="${t}">` +
        (textsOn()
          ? '<label for="m">Your mobile number, if you also want a text when they need help (optional)</label><br>' +
            '<input id="m" name="phone" type="tel" autocomplete="tel" inputmode="tel" placeholder="+1 602 555 0100" style="font:inherit;padding:.6rem;width:100%;margin:.5rem 0;border-radius:.4rem;border:1px solid #888"><br>'
          : '') +
        '<button name="answer" value="yes">Yes, send them to me</button><button class="no" name="answer" value="no">No</button></form>',
    );
  });

  app.post('/contact/accept', form, (req, res) => {
    if (limited(req, res)) return;
    const t = String((req.body as { t?: unknown })?.t ?? '');
    const answer = String((req.body as { answer?: unknown })?.answer ?? '');
    const hit = TOKEN.test(t) ? findByHash(hashOf(t)) : null;
    if (!hit) return send(res, 404, 'Link not valid', GONE);
    const hash = hashOf(t);
    if (answer === 'yes') {
      // Their own number, typed by them, here. Anything that is not a phone number is ignored, not stored.
      const phone = textsOn() ? phoneOf(String((req.body as { phone?: unknown })?.phone ?? '').slice(0, 30)) : null;
      store.update(hit.id, (p) => {
        const c = p.contacts.find((x) => x.acceptHash === hash);
        if (c) {
          if (phone) c.phone = phone;
          c.acceptedAt = new Date().toISOString();
          // Used once. The stop link is what works from here on.
          c.acceptHash = null;
        }
      });
      return send(res, 200, 'Agreed', '<h1>Thank you</h1><p>You will be emailed when it matters, and every email has a link that stops them.</p>');
    }
    store.update(hit.id, (p) => void (p.contacts = p.contacts.filter((x) => x.acceptHash !== hash)));
    return send(res, 200, 'Declined', '<h1>Understood</h1><p>You have been removed. Nothing will be sent to you.</p>');
  });

  app.get('/contact/enter', (req, res) => {
    if (limited(req, res)) return;
    const e = String(req.query.e ?? '');
    const hit = TOKEN.test(e) ? findEntry(hashOf(e)) : null;
    if (!hit) return send(res, 404, 'Link not valid', '<h1>This page is no longer valid</h1><p>It lasts fifteen minutes and works once. Ask again and a new one will be made.</p>');
    send(
      res,
      200,
      'Type their email address',
      '<h1>Their email address</h1><p>Type it here, where every letter can be checked. Nothing is sent to them until you say yes, and then only a note asking whether they agree.</p>' +
        `<form method="post" action="/contact/enter"><input type="hidden" name="e" value="${e}">` +
        '<label for="a">Email address</label><br><input id="a" name="email" type="email" required autocomplete="off" inputmode="email" style="font:inherit;padding:.6rem;width:100%;margin:.5rem 0;border-radius:.4rem;border:1px solid #888">' +
        '<button>Save it</button></form>',
    );
  });

  app.post('/contact/enter', form, (req, res) => {
    if (limited(req, res)) return;
    const e = String((req.body as { e?: unknown })?.e ?? '');
    const email = String((req.body as { email?: unknown })?.email ?? '').trim().slice(0, 254);
    const hit = TOKEN.test(e) ? findEntry(hashOf(e)) : null;
    if (!hit) return send(res, 404, 'Link not valid', GONE);
    if (!EMAIL.test(email)) return send(res, 400, 'Check the address', '<h1>That does not look like an email address</h1><p>Go back and check it.</p>');
    const hash = hashOf(e);
    const { name, relation, notifyOn } = hit.entry;
    let full = false;
    store.update(hit.id, (p) => {
      p.entries = (p.entries ?? []).filter((x) => x.hash !== hash);
      const same = (c: { name: string; email: string }) => c.name.trim().toLowerCase() === name.trim().toLowerCase() || c.email.toLowerCase() === email.toLowerCase();
      if (!p.contacts.some(same) && p.contacts.length >= store.LIMITS.contacts) { full = true; return; }
      p.contacts = p.contacts.filter((c) => !same(c));
      p.contacts.push({ id: `contact-${randomBytes(5).toString('hex')}`, name, email, relation, notifyOn, addedAt: new Date().toISOString(), confirmedAt: null });
      p.notices = [...(p.notices ?? []), `I have the address for ${name} now. Say yes and I will ask them to agree.`].slice(-3);
    });
    if (full) return send(res, 409, 'List is full', '<h1>The list is full</h1><p>Take somebody off first, then ask again.</p>');
    return send(res, 200, 'Saved', '<h1>Saved</h1><p>Go back and say yes to add them. Nothing has been sent yet.</p>');
  });

  app.get('/contact/reply', (req, res) => {
    if (limited(req, res)) return;
    const r = String(req.query.r ?? '');
    if (!TOKEN.test(r) || !findAsk(hashOf(r))) return send(res, 404, 'Link not valid', '<h1>This link is no longer valid</h1><p>It may have been used already, or it is more than six hours old. Ring them instead.</p>');
    send(
      res,
      200,
      'Answer them',
      '<h1>They asked for help</h1><p>What you press here is said to them the next time they speak to Sudor. It does not replace ringing them.</p>' +
        `<form method="post" action="/contact/reply"><input type="hidden" name="r" value="${r}">` +
        '<button name="answer" value="coming">I\'m on my way</button><button class="no" name="answer" value="call">Ask them to ring me</button></form>',
    );
  });

  app.post('/contact/reply', form, (req, res) => {
    if (limited(req, res)) return;
    const r = String((req.body as { r?: unknown })?.r ?? '');
    const answer = String((req.body as { answer?: unknown })?.answer ?? '');
    const hit = TOKEN.test(r) ? findAsk(hashOf(r)) : null;
    if (!hit || (answer !== 'coming' && answer !== 'call')) return send(res, 404, 'Link not valid', GONE);
    const hash = hashOf(r);
    store.update(hit.id, (p) => {
      // Used once, so a forwarded email cannot be answered twice.
      p.helpAsks = (p.helpAsks ?? []).filter((a) => a.hash !== hash);
      p.helpReplies = [...(p.helpReplies ?? []), { from: hit.contact, answer: answer as 'coming' | 'call', at: new Date().toISOString() }].slice(-10);
    });
    return send(res, 200, 'Sent', '<h1>They will be told</h1><p>The next time they speak to Sudor they will hear your answer. If you can, ring them now as well.</p>');
  });

  app.get('/contact/stop', (req, res) => {
    if (limited(req, res)) return;
    const s = String(req.query.s ?? '');
    if (!STOP.test(s) || !findByStop(s)) return send(res, 404, 'Link not valid', GONE);
    send(
      res,
      200,
      'Stop these emails',
      '<h1>Stop these emails?</h1><p>You will not be told about heat, cold or a call for help from this person again.</p>' +
        `<form method="post" action="/contact/stop"><input type="hidden" name="s" value="${s}"><button name="answer" value="stop">Stop them</button></form>`,
    );
  });

  app.post('/contact/stop', form, (req, res) => {
    if (limited(req, res)) return;
    const s = String((req.body as { s?: unknown })?.s ?? '');
    const hit = STOP.test(s) ? findByStop(s) : null;
    if (!hit) return send(res, 404, 'Link not valid', GONE);
    store.update(hit.id, (p) => void (p.contacts = p.contacts.filter((x) => x.stopId !== s)));
    return send(res, 200, 'Stopped', '<h1>Stopped</h1><p>You have been removed. Nothing more will be sent to you.</p>');
  });
}
