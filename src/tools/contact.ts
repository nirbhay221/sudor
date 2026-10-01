/**
 * Who to tell when it matters.
 *
 * One of the grouped tool modules split out of tools.ts. The code is unchanged
 * from when it lived there; only the file it lives in is new.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assess, heatIndexF, photoRisk, type HeatCategory } from '../domain.js';
import { findMedication as classifyMedication, nearMatches, MEDICATIONS, articleFor, COLD_MECHANISM_SAY, type ColdMechanism } from '../meds.js';
import { chooseOne, canAsk } from '../elicit.js';
import { CONDITIONS, findCondition } from '../conditions.js';
import { windChillF, coldCategory, coldMeaning, COLD_WORDS, matchColdFirstAid } from '../cold.js';
import { profileOf, judgeHour, planDay, precautions } from '../personal.js';
import * as wbgt from '../wbgt.js';
import { triage } from '../firstaid.js';
import { geocode } from '../geocode.js';
import { alertEmergency } from '../alerts.js';
import { emailConfigured } from '../notify.js';
import * as weather from '../weather.js';
import * as store from '../store.js';
import * as recalls from '../recalls.js';
import * as warnings from '../warnings.js';
import * as spaceweather from '../spaceweather.js';
import * as shelters from '../shelters.js';
import {
  clean,
  describeWhen,
  maskEmail,
  sameName,
  say,
} from './shared.js';

export function register(server: McpServer, personOf: () => string): void {
  /* ---------------------------------------------------------------- *
   * Telling someone else, only once the person has said yes.
   * ---------------------------------------------------------------- */
  /*
   * One door for the people who get told.
   *
   * Adding, confirming and removing are one conversation, and the confirm step
   * is the safety property: nothing is ever emailed to anyone who has not been
   * confirmed, whichever door it came through.
   */
  server.registerTool(
    'contact',
    {
      title: 'Who to tell',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      description:
        'Manage the family members or caregivers who get emailed when it matters: if signs of heat stroke are ' +
        'described, the evening before a day that stays too hot, or both. action add stages someone and nothing is ' +
        'sent until action confirm, which the customer must say yes to first. action remove stops emailing them. Call ' +
        'this when someone says to tell, add, confirm or stop telling a family member or carer.',
      inputSchema: {
        action: z.enum(['add', 'confirm', 'remove']).describe(
          'add to stage someone, confirm after the customer says yes, remove to stop emailing them',
        ),
        name: z.string().describe('Who, e.g. "Priya"'),
        email: z.string().email().optional().describe('Their email address, required when adding'),
        relation: z.string().optional().describe('e.g. "daughter", "neighbour", "care aide"'),
        when: z
          .enum(['emergency', 'hot_day', 'both'])
          .optional()
          .describe('emergency for heat stroke signs, hot_day for stay-inside days, both by default'),
      },
    },
    async ({ action, name, email, relation, when }) => {
      const id = personOf();
      name = clean(name, 60);

      if (action === 'add') {
        if (!email) return say(`I need an email address for ${name} before I can add them.`, { staged: false, needs: 'email' });
        relation = relation ? clean(relation, 60) : undefined;
        const notifyOn: store.NotifyReason[] =
          when === 'emergency' ? ['emergency'] : when === 'hot_day' ? ['hot_day'] : ['emergency', 'hot_day'];
        const person = store.get(id);
        // Replacing somebody already on the list is not an addition.
        const replacing = person.contacts.some((c) => sameName(c.name, name) || c.email.toLowerCase() === email.toLowerCase());
        if (!replacing && person.contacts.length >= store.LIMITS.contacts) {
          return say(
            'That is as many people as I can keep on the list. Take somebody off first if you need to add another.',
            { staged: false, reason: 'limit' },
          );
        }
        store.update(id, (p) => {
          p.contacts = p.contacts.filter((c) => !sameName(c.name, name) && c.email.toLowerCase() !== email.toLowerCase());
          p.contacts.push({
            name,
            email,
            relation: relation ?? null,
            notifyOn,
            addedAt: new Date().toISOString(),
            confirmedAt: null,
          });
        });
        const spokenEmail = person.privacy ? maskEmail(email) : email;
        return say(
          `I'll email ${name}${relation ? `, your ${relation},` : ''} at ${spokenEmail} ${describeWhen(notifyOn)}. ` +
            `Nothing is sent until you confirm. Should I add ${name}?`,
          { staged: true, name, notifyOn },
        );
      }

      if (action === 'confirm') {
        const contact = store.get(id).contacts.find((c) => sameName(c.name, name));
        if (!contact) return say(`I don't have anyone called ${name} waiting to be added. Tell me who to add first.`, { confirmed: false });
        store.update(id, (p) => {
          const c = p.contacts.find((x) => sameName(x.name, name));
          if (c && !c.confirmedAt) c.confirmedAt = new Date().toISOString();
        });
        return say(
          `Done. ${contact.name} will get an email ${describeWhen(contact.notifyOn)}.` +
            (emailConfigured() ? '' : " Email isn't switched on for this server yet, so nothing can actually be sent until it is."),
          { confirmed: true, name: contact.name, emailConfigured: emailConfigured() },
        );
      }

      if (!store.get(id).contacts.some((c) => sameName(c.name, name))) {
        return say(`${name} isn't one of your contacts.`, { removed: false });
      }
      store.update(id, (p) => void (p.contacts = p.contacts.filter((c) => !sameName(c.name, name))));
      return say(`Removed ${name}. They won't be emailed.`, { removed: true });
    },
  );

}
