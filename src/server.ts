/**
 * Streamable HTTP MCP server (spec 2025-11-25) for Alexa+.
 *
 * Weather is polled per registered location on a 20-minute background timer,
 * never inside a tool call: a single Open-Meteo call measured 420-480ms on
 * its own, against Alexa+'s ~500ms budget. Every request is served from
 * memory.
 */

import express from 'express';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools, resolveLocation } from './tools.js';
import { checkHotDayAlerts } from './alerts.js';
import { MEDICATIONS } from './meds.js';
import { CONDITIONS } from './conditions.js';
import * as weather from './weather.js';
import * as store from './store.js';
import * as recalls from './recalls.js';
import * as warnings from './warnings.js';
import * as spaceweather from './spaceweather.js';
import * as shelters from './shelters.js';
import { AUTH_ON, mountAuth, requireAuth, subjectOf } from './auth.js';

const PORT = Number(process.env.PORT ?? 8789);
const WINDOW_HTML = resolve('./ui/window.html');

/** Whose medications and location these are. See auth.ts for what set this. */
function personFrom(req: express.Request): string {
  const subject = subjectOf(req);
  if (subject) return `acct:${subject}`;
  if (AUTH_ON) throw new Error('unauthenticated request reached the MCP handler');
  // The demo page gives every browser its own id. A profile holds medications
  // and conditions, so sharing one between visitors would mean showing one
  // person's health list to another. Anything that is not a plain id falls back
  // to the development profile.
  const demo = String(req.get('x-sudor-demo') ?? '');
  if (/^[a-z0-9-]{8,64}$/.test(demo)) return `demo:${demo}`;
  return 'local-dev';
}

function build(personId: string): McpServer {
  const server = new McpServer(
    { name: 'sudor', version: '0.1.0' },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        "This add-on plans a customer's day around the heat for their own body: the medications they take and the " +
        "health conditions they have, such as MS, erythromelalgia, heart disease or diabetes, against live local heat, " +
        "UV and air quality. It finds the best time to go out, gives precautions when they must go out anyway, and the " +
        "warning signs of heat illness. Always read the returned answer aloud in full. If it says to call 911, read " +
        "that first and immediately. If the weather service is unreachable, say so plainly rather than guessing.",
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

  return server;
}

/**
 * A refusal in words a person can act on, instead of the protocol's own.
 *
 * When arguments do not match a tool's schema, the SDK answers with its own
 * sentence: "MCP error -32602: Input validation error: Invalid arguments for
 * tool can_i_run: Invalid enum value. Expected 'planting' | 'tillage'...".
 * That text is what the host reads, and Amazon's functional requirements are
 * explicit that no API codes, tool names or JSON reach a customer-facing
 * response, and that every error carries an actionable next step. The MCP
 * specification agrees: it files input validation errors under tool execution
 * errors, which "contain actionable feedback that language models can use to
 * self-correct", not under protocol errors. So the tools/call handler is
 * wrapped and those two cases are put back into English:
 * a word we did not recognise, where the choices are worth offering, and
 * anything else, where the honest answer is that the detail did not arrive.
 *
 * Five choices at most, because the voice requirements cap spoken options at
 * five. If the SDK ever stops reporting errors this way, the wrapper simply
 * finds nothing to rewrite, and test-contract.mjs is what notices.
 */
function plainly(message: string): string {
  // Only the part before "received": the word that was rejected is in the same
  // message, and offering it back as a choice is worse than saying nothing. The
  // options are spoken, so an id like strip_till has to lose its underscore.
  const expectedPart = message.split(/,\s*received/)[0];
  const options = [...expectedPart.matchAll(/'([a-z_]{2,})'/g)].map((m) => m[1].replace(/_/g, ' '));
  const expected = /Invalid enum value|Invalid literal/.test(message) && options.length > 1;
  if (expected) {
    const few = options.slice(0, 5).join(', ');
    return `I didn't catch which one you meant. I can do ${few}${options.length > 5 ? ', and a few more' : ''}. Which is it?`;
  }
  if (/not found/i.test(message)) {
    return "I can't do that one. Ask me what I can do and I'll tell you what I have.";
  }
  return "I didn't get one of the details I need for that. Tell me again in your own words and I'll have another go.";
}

/** Swap the protocol's error text for that, leaving every other answer alone. */
function speakErrorsPlainly(server: McpServer): void {
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, Function> })._requestHandlers;
  const inner = handlers?.get('tools/call');
  if (!handlers || !inner) return;
  handlers.set('tools/call', async (request: unknown, extra: unknown) => {
    const result = (await inner(request, extra)) as { isError?: boolean; content?: { type: string; text?: string }[] };
    const spoken = result?.content?.[0]?.text;
    if (result?.isError && typeof spoken === 'string' && /^MCP error/.test(spoken)) {
      return { ...result, content: [{ type: 'text', text: plainly(spoken) }] };
    }
    return result;
  });
}

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

mountAuth(app);

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    transport: 'streamable-http',
    spec: '2025-11-25',
    auth: AUTH_ON ? 'oauth2.1+pkce' : 'off (local dev)',
    sheltersOpenNationally: shelters.openNationally(),
    medicationsKnown: MEDICATIONS.length,
    conditionsKnown: CONDITIONS.length,
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
    return personFrom(req) || req.ip || 'unknown';
  } catch {
    return req.ip ?? 'unknown';
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

app.all('/mcp', widenWildcardAccept, rateLimit, requireAuth, async (req, res) => {
  const started = Date.now();
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
    console.error('[mcp] error', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  } finally {
    const ms = Date.now() - started;
    console.log(`[mcp] ${req.method} ${ms}ms${ms > 400 ? '  <-- OVER BUDGET' : ''}`);
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
    weather.watch(person.lat, person.lon);
    warnings.watch(person.lat, person.lon);
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

const warningTimer = setInterval(watchWarnings, 10 * 60 * 1000);
warningTimer.unref?.();

// The FDA recall list, checked in the background for every medicine anyone has
// registered. The feed updates about weekly, so six hours is already generous,
// and it means the recall tool never waits on a network call.
const watchRecalls = () => {
  const generics = new Set<string>();
  for (const [, person] of store.allEntries()) for (const m of person.medications) generics.add(m.generic);
  for (const generic of generics) recalls.watch(generic);
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
