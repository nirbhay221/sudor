/**
 * Streamable HTTP MCP server (spec 2025-11-25) for Alexa+.
 *
 * Weather is polled per registered location on a 20-minute background timer,
 * never inside a tool call: a single Open-Meteo call measured 420-480ms on
 * its own, against Alexa+'s ~500ms budget. Every request is served from
 * memory.
 */

import * as recallsuk from './recallsuk.js';
import * as recallsca from './recallsca.js';
import * as outlook from './outlook.js';
import { inUS } from './world.js';
import { chooseByWords } from './rules.js';
import * as devices from './devices.js';
import { speakErrorsPlainly } from './plainly.js';
import express from 'express';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools, resolveLocation } from './tools.js';
import { checkHotDayAlerts, checkWarningAlerts, checkOnAlone } from './alerts.js';
import { MEDICATIONS } from './meds.js';
import { CONDITIONS } from './conditions.js';
import * as weather from './weather.js';
import * as store from './store.js';
import * as recalls from './recalls.js';
import * as warnings from './warnings.js';
import * as spaceweather from './spaceweather.js';
import * as care from './care.js';
import { mountConsent } from './consent.js';
import { demoPhone } from './notify.js';
import * as shelters from './shelters.js';
import { AUTH_ON, demoIdOf, mountAuth, requireAuth, subjectOf } from './auth.js';
import { requireOrigin, requireOriginSecret, originSecretConfigured } from './origin.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as agent from './agent.js';
import * as speak from './speak.js';
import * as trace from './trace.js';
import * as vault from './vault.js';
import { dailyCap, perCaller } from './budget.js';

/**
 * Carried in every stand-in response, so the disclaimer travels with the data
 * rather than living in a README. This is a model playing the part Alexa+ would
 * play; it does not share Alexa's prompt, its turn budget, or its judgment about
 * when to call something.
 */
const STAND_IN_NOTE =
  "Alexa+ stand-in: a model reading this server's real tools/list and calling it over MCP. Not Alexa.";

// Before anything reads the people file. With SUDOR_REQUIRE_ENCRYPTION=on a
// missing key stops the process here, rather than letting it serve medications
// out of a plaintext file because somebody forgot an environment variable.
vault.assertRequirementMet();

const PORT = Number(process.env.PORT ?? 8789);
const WINDOW_HTML = resolve('./ui/window.html');
const CARD_HTML = resolve('./ui/card.html');

/** Whose medications and location these are. See auth.ts for what set this. */
function personFrom(req: express.Request): string {
  const subject = subjectOf(req);
  if (subject) return `acct:${subject}`;
  // A profile holds medications and conditions, so two visitors must never share
  // one. Each browser has its own 128 bit id, and it only ever reaches `demo:`.
  const demo = demoIdOf(req);
  if (demo) return `demo:${demo}`;
  if (AUTH_ON) throw new Error('unauthenticated request reached the MCP handler');
  return 'local-dev';
}

/*
 * Instructions that say what this customer has already told the add-on, as yes or no and a count, never the
 * values. A host that reads "a place is saved" calls the tool instead of asking where they live, which is the
 * mistake a model made in testing on four sentences out of fifteen. The same idea as "context-aware tools":
 * tell the model what is known for this person, not only what each tool does.
 */
/** The main language of each Alexa+ country that is not English-speaking. */
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
        "profile is the customer's own: never record another person's place or medicines in it with about_me.";
  const p = store.get(personId);
  const known = [
    p.lat != null || p.locationStatus === 'locating' ? 'a place' : '',
    p.medications.length ? `${p.medications.length} medicine${p.medications.length === 1 ? '' : 's'}` : '',
    p.conditions.length ? `${p.conditions.length} health condition${p.conditions.length === 1 ? '' : 's'}` : '',
    (p.equipment ?? []).length ? 'medical equipment' : '',
    p.cooling ? 'their home cooling' : '',
    p.contacts.length ? 'family contacts' : '',
  ].filter(Boolean);
  // Amazon Translate is not available to this account, and Alexa+ is itself a language model that answers in the
  // customer's language. So the host is told which language this person most likely speaks, from their country,
  // and to keep the parts that must not drift exactly as given.
  const lang = LANGUAGE[(p.country ?? 'US').toUpperCase()];
  const say = lang
    ? ` This customer lives where ${lang} is spoken: unless they speak to you in English, give the answer in ${lang}, translating it faithfully, and keep every number, every medicine name and the emergency number exactly as given.`
    : '';
  return known.length
    ? `${base}${say} This customer has already saved ${known.join(', ')}. Use what is saved: do not ask for it again.`
    : `${base}${say} This customer has not saved anything yet; a tool will say what it needs.`;
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

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    transport: 'streamable-http',
    spec: '2025-11-25',
    auth: AUTH_ON ? 'oauth2.1+pkce' : 'off (local dev)',
    sheltersOpenNationally: shelters.openNationally(),
    hospitals: care.status(),
    medicationsKnown: MEDICATIONS.length,
    conditionsKnown: CONDITIONS.length,
    speech: speak.status(),
    storage: vault.status(),
    budgets: { agent: agentDaily.status(), speechCharacters: speakDaily.status() },
    followedPlaces: weather.watched(),
    // Whether the link to Orbita is alive, and what it last saw. Absent when
    // this server has not been pointed at one.
    spaceWeather: spaceweather.configured()
      ? (() => {
          const seen = spaceweather.lastSeen();
          return seen
            ? { linked: true, g: seen.g, when: seen.when, ageMinutes: Math.round((Date.now() - seen.fetchedAt) / 60000) }
            : { linked: false };
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

/**
 * Strips the three keys that break argument parsing.
 *
 * Found by fuzzing: a tools/call whose arguments contain a key named "constructor" is answered with
 * "-32603 Internal error" and a raw dump of a validation library's issue list, from any tool, because the
 * SDK's schema parsing trips over a key that collides with Object.prototype. That is an upstream bug, and
 * the effect for us is the thing Amazon's requirements say never to do: expose an internal error. No
 * tool takes arguments with these names, so they are removed from the arguments before the request
 * reaches the SDK, and the call then behaves exactly like any other call with an argument nobody asked for.
 */
const UNSAFE_KEYS = ['constructor', 'prototype', '__proto__'];
function stripUnsafeKeys(value: unknown, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 8) return;
  for (const key of UNSAFE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) delete (value as Record<string, unknown>)[key];
  }
  for (const child of Object.values(value as Record<string, unknown>)) stripUnsafeKeys(child, depth + 1);
}
const dropUnsafeArguments: express.RequestHandler = (req, _res, next) => {
  const body = req.body as unknown;
  for (const message of Array.isArray(body) ? body : [body]) {
    const params = (message as { params?: { arguments?: unknown } } | null)?.params;
    if (params?.arguments) stripUnsafeKeys(params.arguments);
  }
  next();
};

/**
 * A client that will take anything does take both of the two types the
 * transport insists on.
 *
 * The Streamable HTTP transport rejects a POST unless Accept names both
 * application/json and text/event-stream, which is what the spec asks clients
 * to send. But curl's default Accept is the wildcard, and a probe found that a
 * plain curl to this endpoint came back 406, which reads as a broken server
 * rather than a picky one. A wildcard is rewritten to the pair it already
 * covers. An Accept that names application/json and nothing else is left to be
 * refused, because that client really cannot read the stream we answer with.
 */
const widenWildcardAccept: express.RequestHandler = (req, _res, next) => {
  const accept = String(req.headers.accept ?? '').trim();
  const wildcard = !accept || accept.split(',').some((part) => part.trim().split(';')[0] === '*/*');
  if (wildcard) req.headers.accept = 'application/json, text/event-stream';
  next();
};


/**
 * A ceiling on how fast one caller can be served.
 *
 * The specification's security section asks servers to rate limit tool
 * invocations, and this endpoint is public. A token bucket: a burst of
 * __BURST__ is fine, and it refills at __RATE__ a second, which is far above
 * anything a voice conversation does and far below what a script does. The
 * bucket is per caller, so one noisy visitor cannot spend everyone else's.
 */
const BURST = Number(process.env.SUDOR_BURST ?? 600);
const REFILL_PER_SECOND = Number(process.env.SUDOR_REFILL ?? 10);
const buckets = new Map<string, { tokens: number; at: number }>();

function withinRate(key: string): boolean {
  const now = Date.now();
  const held = buckets.get(key) ?? { tokens: BURST, at: now };
  const refilled = Math.min(BURST, held.tokens + ((now - held.at) / 1000) * REFILL_PER_SECOND);
  if (refilled < 1) {
    buckets.set(key, { tokens: refilled, at: now });
    return false;
  }
  buckets.set(key, { tokens: refilled - 1, at: now });
  // Callers who have gone quiet and are back to a full bucket cost nothing to forget.
  if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.tokens >= BURST - 1) buckets.delete(k);
  return true;
}

/*
 * Who to charge for this request, worked out before authentication has run.
 * personFrom throws on an unauthenticated request when auth is on, which is the
 * right thing for a tool call and the wrong thing here: a limiter that throws
 * turns a 401 into a 500, which a probe caught immediately.
 */
const callerKey = (req: express.Request): string => {
  try {
    const who = personFrom(req);
    // A linked account is a stable identity and is charged as itself. A sandbox
    // identity is not: anyone can invent a new 128 bit id for free, so keying the
    // limiter on it gives every request a fresh bucket and turns every per caller
    // limit, including the ones on the paid endpoints, into decoration. Sandbox
    // callers are charged by network address instead.
    if (who.startsWith('acct:')) return who;
    return `ip:${req.ip ?? 'unknown'}`;
  } catch {
    return `ip:${req.ip ?? 'unknown'}`;
  }
};

const rateLimit: express.RequestHandler = (req, res, next) => {
  const key = callerKey(req);
  if (withinRate(key)) return next();
  res.status(429).set('Retry-After', '1').json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Too many requests. Slow down and try again in a moment.' },
    id: null,
  });
};


/**
 * What the paid endpoints are allowed to cost. See budget.ts for why there are two
 * kinds of limit and what each one is for.
 *
 * A model call is a few cents; 300 a day is roughly the price of a coffee and is far
 * more than a judge clicking through a demo will use. Speech is metered in characters
 * because that is what Polly bills, and a cache hit is free, so the same six canned
 * answers replayed all day cost six syntheses.
 */
const agentDaily = dailyCap(Number(process.env.SUDOR_AGENT_DAILY_MAX ?? 25));
const speakDaily = dailyCap(Number(process.env.SUDOR_SPEAK_DAILY_CHARS ?? 100_000));
// Burst and sustained rate per caller. A person typing into the stand-in does not
// send six requests a minute; the defaults are for people and the knobs are for tests
// and for an operator who has a reason.
const agentPerCaller = perCaller(Number(process.env.SUDOR_AGENT_BURST ?? 3), Number(process.env.SUDOR_AGENT_PER_MINUTE ?? 6));
const speakPerCaller = perCaller(Number(process.env.SUDOR_SPEAK_BURST ?? 5), Number(process.env.SUDOR_SPEAK_PER_MINUTE ?? 20));

/**
 * The Alexa+ stand-in.
 *
 * A model reads this server's own `tools/list` cold, decides what the sentence
 * means, and the chosen call is executed through the real protocol. Both halves
 * are returned, so a viewer sees the decision and not only the answer, which is
 * the point: the decision is what a real host would have had to make from the
 * tool descriptions alone.
 *
 * The round trip goes through an in-memory MCP transport rather than calling the
 * tool handlers directly. That costs a few milliseconds and buys the thing that
 * makes the demo worth anything: the schemas the model reads are the schemas the
 * protocol publishes, and the call it makes is validated and dispatched exactly
 * as a real host's would be.
 *
 * Nothing the model says is stored, and nothing it chooses is executed outside
 * this request. What the tools themselves write, they write for the same person
 * the request is scoped to, exactly as an Alexa+ call would.
 */
app.post('/agent', requireAuth, async (req, res) => {
  // Identity and spend are checked before anything else, including whether the
  // stand-in is configured, so an unconfigured server cannot be used to find out
  // which of the two a caller failed.
  if (!agentPerCaller.allow(callerKey(req))) {
    res.status(429).set('Retry-After', '10').json({ error: 'slow_down', detail: 'Too many stand-in requests. Try again in a few seconds.' });
    return;
  }
  const utterance = typeof req.body?.say === 'string' ? req.body.say.slice(0, 500).trim() : '';
  if (!utterance) {
    res.status(400).json({ error: 'say_required' });
    return;
  }
  // Last, so a malformed request never spends a unit of the budget.
  // No model configured, or today's model budget spent: the word rules choose instead, and say so. See rules.ts.
  const useModel = agent.configured() && agentDaily.take(1);

  const server = build(personFrom(req));
  const client = new Client({ name: 'alexa-plus-stand-in', version: '0.1.0' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const listed = await client.listTools();
    const chosen = useModel ? await agent.choose(utterance, listed.tools as agent.ToolDef[], client.getInstructions() ?? '') : chooseByWords(utterance, listed.tools as agent.ToolDef[]);

    // A decline is a real outcome. A host that calls nothing when nothing fits is
    // behaving correctly, and flattening that into an error would hide it.
    if (!chosen.tool) {
      res.json({ standIn: STAND_IN_NOTE, utterance, chose: null, said: chosen.said, ms: chosen.ms, model: chosen.model });
      return;
    }

    const result = await client.callTool({ name: chosen.tool, arguments: chosen.args });
    res.json({
      standIn: STAND_IN_NOTE, utterance,
      chose: { tool: chosen.tool, args: chosen.args },
      said: chosen.said, ms: chosen.ms, model: chosen.model, result,
    });
  } catch (err) {
    console.error('[agent]', err);
    res.status(502).json({ error: 'stand_in_failed', detail: agent.explainError(err) });
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
});

/**
 * Speak a sentence this server produced.
 *
 * For the demo page and the video only; it is not part of the MCP path, because
 * Alexa+ does its own speech. The point is narrow and it matters here: the
 * emergency phrasing has to land at the speed of speech, once, to somebody who is
 * frightened, and a page of text cannot show whether it does.
 */
app.post('/speak', requireAuth, async (req, res) => {
  if (!speakPerCaller.allow(callerKey(req))) {
    res.status(429).set('Retry-After', '5').json({ error: 'slow_down' });
    return;
  }
  if (!speak.SPEAK_ON) {
    res.status(503).json({
      error: 'not_enabled',
      detail: 'Set SUDOR_SPEAK=on to enable spoken answers. The demo works as text without it.',
    });
    return;
  }
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (!speak.usable(text.trim().replace(/\s+/g, ' '))) {
    res.status(400).json({ error: 'not_speakable' });
    return;
  }
  // Characters are what Polly bills, and a sentence already held costs nothing, so
  // only a synthesis is charged against the day.
  if (!speak.isCached(text) && !speakDaily.take(text.trim().length)) {
    res.status(429).json({ error: 'daily_budget', detail: 'Spoken answers have reached their limit for today.' });
    return;
  }
  try {
    const out = await speak.speak(text);
    res.setHeader('content-type', 'audio/mpeg');
    // Cached by content hash server side; let the browser hold it too, since the
    // same canned answers are replayed constantly during a demo.
    res.setHeader('cache-control', 'public, max-age=3600');
    res.setHeader('x-sudor-cached', out.cached ? '1' : '0');
    res.send(Buffer.from(out.audio));
  } catch (err) {
    console.error('[speak]', err);
    res.status(502).json({ error: 'speak_failed' });
  }
});

app.all('/mcp', widenWildcardAccept, dropUnsafeArguments, rateLimit, requireAuth, async (req, res) => {
  const started = Date.now();
  // One id per request, echoed in any error logged while handling it.
  const traceId = trace.newTraceId();
  let failure: string | undefined;
  try {
    const server = build(personFrom(req));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
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
      // Which feed was stale when the answer was given. The storm link is the one
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

// Resume watching every location a restart would otherwise have forgotten, and
// finish any spoken place lookup the restart cut off.
for (const [id, person] of store.allEntries()) {
  if (person.lat != null && person.lon != null) {
    weather.watch(person.lat, person.lon, !id.startsWith('demo:'));
    warnings.watch(person.lat, person.lon);
    care.watch(person.lat, person.lon, person.locationName);
  }
  else if (person.locationStatus === 'locating' && person.locationName) resolveLocation(id, person.locationName);
}

// Official warnings, checked every ten minutes for every place anyone has
// registered. Alerts change faster than the forecast does, and the endpoint
// answered in about 900 ms in testing, which is twice a whole voice turn.
const watchWarnings = () => {
  for (const [, person] of store.allEntries()) {
    if (person.lat != null && person.lon != null) warnings.watch(person.lat, person.lon);
  }
};
void spaceweather.start();
void shelters.start();

const warningTimer = setInterval(() => {
  watchWarnings();
  // And tell the family, once, when a warning starts where somebody lives. See alerts.ts.
  checkWarningAlerts().catch((err) => console.error('[alerts]', err));
  // And somebody who lives alone and has not been heard from on a dangerous day. See alerts.ts.
  checkOnAlone().catch((err) => console.error('[alerts]', err));
}, 10 * 60 * 1000);
warningTimer.unref?.();

// The FDA recall list, checked in the background for every medicine anyone has
// registered. The feed updates about weekly, so six hours is already generous,
// and it means the recall tool never waits on a network call.
const watchRecalls = () => {
  const generics = new Set<string>();
  for (const [, person] of store.allEntries()) for (const m of person.medications) generics.add(m.generic);
  for (const generic of generics) recalls.watch(generic);
  // The same for the kinds of medical equipment people have said they rely on. See devices.ts.
  const kinds = new Set<string>();
  for (const [, person] of store.allEntries()) for (const k of person.equipment ?? []) kinds.add(k);
  for (const k of kinds) devices.watch(k);
  // Health Canada's recall list, once anybody lives in Canada. See recallsca.ts.
  if (store.allEntries().some(([, p]) => p.country === 'CA')) recallsca.start();
  if (store.allEntries().some(([, p]) => p.country === 'GB')) recallsuk.start();
  // The days ahead, for every US place somebody lives. See outlook.ts.
  for (const [, person] of store.allEntries()) if (person.lat != null && person.lon != null && (inUS(person.country) || person.country === 'MX')) outlook.watch(person.lat, person.lon);
};
watchRecalls();
const recallTimer = setInterval(watchRecalls, 6 * 60 * 60 * 1000);
recallTimer.unref?.();

// Stay-inside day emails to confirmed contacts, checked on the same cadence as the weather.
const alertTimer = setInterval(() => {
  checkHotDayAlerts().catch((err) => console.error('[alerts]', err));
}, 20 * 60 * 1000);
alertTimer.unref?.();

/*
 * Demo records are swept once a day. A profile made by a stranger on the demo
 * page has no reason to outlive their visit, and this one holds health details.
 */
const sweepTimer = setInterval(() => {
  const gone = store.expireDemoRecords();
  if (gone) console.log(`[store] expired ${gone} demo record${gone === 1 ? '' : 's'}`);
}, 24 * 60 * 60 * 1000);
sweepTimer.unref?.();
store.expireDemoRecords();

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
    listener.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
