/**
 * Streamable HTTP MCP server (spec 2025-11-25) for Alexa+.
 *
 * Weather is polled per registered location on a 20-minute background timer,
 * never inside a tool call: a single Open-Meteo call measured 420-480ms on
 * its own, against Alexa+'s ~500ms budget. Every request is served from
 * memory.
 *
 * This file is the wiring: the MCP endpoint, the routes, and the start. The rest is beside it:
 *
 *   caller.ts      who a request is for, and who to charge for it
 *   guards.ts      what every MCP request passes through first
 *   standin.ts     the Alexa+ stand-in and speech, for the demo page
 *   background.ts  everything kept up to date between requests, and the alert timers
 *   tools.ts       the tools, each in tools/, all built on one profile (store.ts, personal.ts)
 */

import { speakErrorsPlainly } from './plainly.js';
import express from 'express';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools.js';
import { registerSkills } from './skill.js';
import * as impact from './impact.js';
import { MEDICATIONS } from './meds.js';
import { CONDITIONS } from './conditions.js';
import * as weather from './weather.js';
import * as store from './store.js';
import * as spaceweather from './spaceweather.js';
import * as care from './care.js';
import { mountConsent } from './consent.js';
import { demoPhone } from './notify.js';
import * as shelters from './shelters.js';
import * as cooling from './cooling.js';
import * as outages from './outages.js';
import { AUTH_ON, demoIdOf, mountAuth, requireAuth } from './auth.js';
import { requireOrigin, requireOriginSecret, originSecretConfigured } from './origin.js';
import * as speak from './speak.js';
import * as trace from './trace.js';
import * as vault from './vault.js';
import { personFrom, callerKey, requestCaller } from './caller.js';
import { dropUnsafeArguments, widenWildcardAccept, rateLimit } from './guards.js';
import { mountStandIn, budgetStatus } from './standin.js';
import { startBackground } from './background.js';

// Before anything reads the people file. With SUDOR_REQUIRE_ENCRYPTION=on a
// missing key stops the process here, rather than letting it serve medications
// out of a plaintext file because somebody forgot an environment variable.
vault.assertRequirementMet();

const PORT = Number(process.env.PORT ?? 8789);
const WINDOW_HTML = resolve('./ui/window.html');
const CARD_HTML = resolve('./ui/card.html');

/*
 * Instructions that say what this customer has already told the add-on, as yes or no and a count, never the
 * values. A host that reads "a place is saved" calls the tool instead of asking where they live, which is the
 * mistake a model made in testing on four sentences out of fifteen. The same idea as "context-aware tools":
 * tell the model what is known for this person, not only what each tool does.
 */
/** The main language of each Alexa+ country that is not English-speaking. */
/** Hosts know the date; so does the stand-in, or "December 20 to 27" is guessed into last year. */
const today = () => ` Today is ${new Date().toISOString().slice(0, 10)}. A date said without a year is the next one to come, unless they are asking about something that has already happened.`;
const LANGUAGE: Record<string, string> = { DE: 'German', AT: 'German', FR: 'French', ES: 'Spanish', MX: 'Spanish', IT: 'Italian', BR: 'Portuguese', IN: 'Hindi or English' };

function instructionsFor(personId: string): string {
  const base =
        "This add-on plans a customer's day around the heat for their own body: the medications they take and the " +
        "health conditions they have, such as MS, erythromelalgia, heart disease or diabetes, against live local heat, " +
        "UV and air quality. It finds the best time to go out, gives precautions when they must go out anyway, and the " +
        "warning signs of heat illness. Always read the returned answer aloud in full. If it says to call 911, read " +
        "that first and immediately. If the weather service is unreachable, say so plainly rather than guessing. " +
        "It remembers the customer: their place, medicines, conditions, equipment and home cooling are saved, so " +
        "call the tool without asking for them; the answer itself says when something is missing. When someone says " +
        "they feel unwell, call warning_signs straight away with their words, before asking anything. The saved " +
        "profile is the customer's own: never record another person's place or medicines in it with about_me. " +
        "Somebody else who lives or travels with them, a parent, a partner, a baby, goes in household, one call per person, " +
        "and the answers about going out, the day and trips then cover them too.";
  const p = store.get(personId);
  const known = [
    p.lat != null || p.locationStatus === 'locating' ? 'a place' : '',
    p.medications.length ? `${p.medications.length} medicine${p.medications.length === 1 ? '' : 's'}` : '',
    p.conditions.length ? `${p.conditions.length} health condition${p.conditions.length === 1 ? '' : 's'}` : '',
    (p.equipment ?? []).length ? 'medical equipment' : '',
    p.cooling ? 'their home cooling' : '',
    p.contacts.length ? 'family contacts' : '',
    (p.household ?? []).length ? 'the people at home' : '',
  ].filter(Boolean);
  // Amazon Translate is not available to this account, and Alexa+ is itself a language model that answers in the
  // customer's language. So the host is told which language this person most likely speaks, from their country,
  // and to keep the parts that must not drift exactly as given.
  const lang = LANGUAGE[(p.country ?? 'US').toUpperCase()];
  // Their own words decide the language. "My mother just fainted", said in English from Sao Paulo, was answered in
  // Portuguese because the country was the first thing the model was told.
  const say = lang
    ? ` Answer in the language the customer used in their last message: English when they wrote English. Only when they speak ${lang} to you, answer in ${lang}, translating faithfully and keeping every number, every medicine name and the emergency number exactly as given.`
    : '';
  return known.length
    ? `${base}${say}${today()} This customer has already saved ${known.join(', ')}. Use what is saved: do not ask for it again.`
    : `${base}${say}${today()} This customer has not saved anything yet; a tool will say what it needs.`;
}

function build(personId: string): McpServer {
  const server = new McpServer(
    {
      name: 'sudor',
      title: 'Sudor',
      description: 'Checks heat and cold against your own medicines and conditions, and says what to do about it.',
      version: '0.1.0',
    },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: instructionsFor(personId),
    },
  );

  registerTools(server, () => personId);
  speakErrorsPlainly(server);

  // The Agent Skill for this add-on, readable from the same connection. See skill.ts.
  registerSkills(server);

  server.registerResource(
    'window',
    'ui://sudor/window.html',
    { title: 'Heat and medication check', mimeType: 'text/html;profile=mcp-app' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/html;profile=mcp-app', text: readFileSync(WINDOW_HTML, 'utf8') }],
    }),
  );

  server.registerResource(
    'card',
    'ui://sudor/card.html',
    { title: 'Sudor card', mimeType: 'text/html;profile=mcp-app' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/html;profile=mcp-app', text: readFileSync(CARD_HTML, 'utf8') }],
    }),
  );

  return server;
}

const app = express();
// Which framework answers is nobody's business, and a response is never read as a type it does not declare.
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
// How many proxies in front of this process to believe.
//
// This used to be `trust proxy: true` unless a hop count was set, which is the opposite of what the
// comment beside it said: with no count configured, Express believed whatever X-Forwarded-For the
// caller sent. Every limit keyed on the caller's address (the sandbox rate limit, the stand-in and
// speech budgets, new-account claims) could then be walked around by sending a different made-up
// address with each request. The default is now to trust nothing.
//
// Behind API Gateway, set SUDOR_TRUST_PROXY=1: every request arrives from the gateway, so without
// it one noisy visitor would spend everyone's allowance, and with it Express reads the address the
// gateway recorded. It must stay unset when the process is reachable directly. The origin secret is
// what makes one hop safe to trust. Behind a tunnel in development, set it to 1 as well, so the
// OAuth URLs carry the scheme and host the client dialled (or set SUDOR_PUBLIC_URL).
const trustedHops = Number(process.env.SUDOR_TRUST_PROXY ?? 0);
app.set('trust proxy', Number.isInteger(trustedHops) && trustedHops > 0 ? trustedHops : false);

// Spec 2025-11-25: a Streamable HTTP server must answer 403 to an Origin it
// does not accept. Mounted before the body parser so a rejected request never
// has its payload read.
app.use(requireOrigin);
// And that it came through the gateway rather than off the street. See origin.ts
// for why a security group rule cannot express this.
app.use(requireOriginSecret);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

mountAuth(app);
// Where somebody who was added as a contact agrees to it, or stops it. See consent.ts.
mountConsent(app);

// The phone on the demo page: the messages a sandbox visitor's contacts would have been emailed, readable
// only with that visitor's own sandbox id. See notify.ts.
app.get('/demo/phone', (req, res) => {
  const id = demoIdOf(req);
  res.setHeader('Cache-Control', 'no-store');
  if (!id) return void res.status(401).json({ error: 'no_sandbox' });
  res.json({ messages: demoPhone(`demo:${id}`) });
});

// Whether anybody acts on what they are told, as daily totals and nothing about anybody. See impact.ts.
app.get('/impact', async (req, res) => {
  const days = Math.min(400, Math.max(1, Number(req.query.days) || 30));
  res.json({ days, ...(await impact.summaryWithTable(days)), measures: 'warned, sent away, asked afterwards, went looking, family told, carer steps, outings fine and unwell' });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    transport: 'streamable-http',
    spec: '2025-11-25',
    auth: AUTH_ON ? 'oauth2.1+pkce' : 'off (local dev)',
    sheltersOpenNationally: shelters.openNationally(),
    coolingCentres: cooling.counts(),
    californiaOutageAreas: outages.areasHeld(),
    hospitals: care.status(),
    medicationsKnown: MEDICATIONS.length,
    conditionsKnown: CONDITIONS.length,
    speech: speak.status(),
    storage: vault.status(),
    budgets: budgetStatus(),
    followedPlaces: weather.watched(),
    // Whether NOAA's space weather feed is being read, and what it last saw. Absent when
    // it is switched off.
    spaceWeather: spaceweather.configured()
      ? (() => {
          const seen = spaceweather.lastSeen();
          return seen
            ? { read: true, g: seen.g, when: seen.when, ageMinutes: Math.round((Date.now() - seen.fetchedAt) / 60000) }
            : { read: false };
        })()
      : null,
  });
});

/**
 * A host that opens a stream gets an answer, not silence.
 *
 * This server is stateless: there is no session to stream events into, so the
 * only useful verb is POST. Passing GET through to the transport left the
 * connection open with nothing ever sent, which a probe found as a hung request
 * and the gateway in front reported as a 503, as though the server were down.
 */
app.get('/mcp', (_req, res) => {
  res.status(405).set('Allow', 'POST').json({
    jsonrpc: '2.0',
    error: { code: -32601, message: 'This server is stateless. Send JSON-RPC over POST /mcp.' },
    id: null,
  });
});
app.delete('/mcp', (_req, res) => {
  res.status(405).set('Allow', 'POST').json({
    jsonrpc: '2.0',
    error: { code: -32601, message: 'This server is stateless. There is no session to end.' },
    id: null,
  });
});

mountStandIn(app, build);

app.all('/mcp', widenWildcardAccept, dropUnsafeArguments, rateLimit, requireAuth, async (req, res) => {
  const started = Date.now();
  // One id per request, echoed in any error logged while handling it.
  const traceId = trace.newTraceId();
  let failure: string | undefined;
  try {
    const who = personFrom(req);
    // A write made elsewhere, such as an alert the scheduled check sent. A no-op for the file store.
    await store.refresh(who).catch((err) => console.error('[store] refresh failed:', err instanceof Error ? err.message : err));
    const server = build(who);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await requestCaller.run(callerKey(req), () => transport.handleRequest(req, res, req.body));
  } catch (err) {
    failure = trace.errClass(err);
    // The message goes to stderr for a human; the line below carries only the
    // class, because a message can contain whatever was interpolated into it and
    // here that could be a medication.
    console.error(`[mcp] ${traceId}`, err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  } finally {
    trace.log({
      t: new Date().toISOString(),
      id: traceId,
      method: typeof req.body?.method === 'string' ? req.body.method : undefined,
      tool: typeof req.body?.params?.name === 'string' ? req.body.params.name : undefined,
      ms: Date.now() - started,
      ok: !failure,
      who: trace.whoHash(personFrom(req)),
      err: failure,
      // Which feed was stale when the answer was given. The storm feed is the one
      // that matters most: a G5 folded into heat advice is only useful if it is current.
      feeds: {
        storm: (() => {
          const seen = spaceweather.lastSeen();
          return seen ? Math.round((Date.now() - seen.fetchedAt) / 60000) : null;
        })(),
        sheltersOpen: shelters.openNationally(),
      },
    });
  }
});

// The demo page, and the panel file it embeds. Mounted after /mcp and the OAuth
// routes so a static file can never shadow an endpoint a client depends on.
const revalidate = (res: express.Response) => res.setHeader('Cache-Control', 'no-cache');
app.use(express.static(resolve('./web'), { setHeaders: revalidate }));
app.use('/ui', express.static(resolve('./ui'), { setHeaders: revalidate }));

// The people table, read before anything uses it. Nothing for the file, which loads itself.
await store.init();
startBackground();

/*
 * Going down on purpose, and not going down by surprise.
 *
 * systemd sends SIGTERM on a redeploy. Without this the process dies mid
 * request and any write still in memory goes with it. And an unhandled
 * rejection anywhere in a background timer takes the whole server out on modern
 * Node, which for a background poll is the wrong trade entirely: log it and
 * keep answering.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[unhandled rejection]', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaught exception]', err.stack ?? err);
});

const listener = app.listen(PORT, () =>
  console.log(
    `sudor MCP on http://localhost:${PORT}/mcp  (auth: ${AUTH_ON ? 'OAuth 2.1 + PKCE' : 'off, set SUDOR_AUTH=on for Alexa+'})`,
  ),
);

/*
 * SIGTERM is what systemd sends on a redeploy. Closing the listener lets the
 * request in flight finish and stops a new one arriving, and the timer is there
 * because a request that will never finish must not hold a redeploy open.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[${signal}] closing`);
    // A change still on its way to DynamoDB goes out before the process does.
    listener.close(() => void store.flush().catch((err) => console.error('[store]', err)).finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
