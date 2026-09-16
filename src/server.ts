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
    medicationsKnown: MEDICATIONS.length,
    conditionsKnown: CONDITIONS.length,
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

app.all('/mcp', requireAuth, async (req, res) => {
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
  if (person.lat != null && person.lon != null) weather.watch(person.lat, person.lon);
  else if (person.locationStatus === 'locating' && person.locationName) resolveLocation(id, person.locationName);
}

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

app.listen(PORT, () =>
  console.log(
    `sudor MCP on http://localhost:${PORT}/mcp  (auth: ${AUTH_ON ? 'OAuth 2.1 + PKCE' : 'off, set SUDOR_AUTH=on for Alexa+'})`,
  ),
);
