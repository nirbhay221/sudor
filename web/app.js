/*
 * The demo page's client.
 *
 * Three jobs: call the MCP endpoint the way a host would, drive the Echo Show
 * panel through the real MCP Apps handshake rather than faking a screenshot,
 * and keep each visitor's demo profile separate from everyone else's.
 *
 * The separation matters more here than on most demos. A profile holds
 * medications and conditions, so one shared profile would mean one visitor
 * reading another visitor's health list. Each browser gets an id, sends it as
 * a header, and the server scopes storage to it.
 */

const SESSION_KEY = 'sudor.demo.session';
const THEME_KEY = 'sudor.demo.theme';

const el = (id) => document.getElementById(id);
/**
 * The visitor's own place, if they offer it.
 *
 * A demo that answers about a farm in Iowa, or a person in Phoenix, is answering
 * about nobody. One click makes every number on this page about where the
 * visitor actually is, which is the only way the answers can be checked against
 * what they can see out of the window.
 */
function askForLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: Number(p.coords.latitude.toFixed(3)), lon: Number(p.coords.longitude.toFixed(3)) }),
      () => resolve(null),
      { timeout: 10000, maximumAge: 600000 },
    );
  });
}

const SESSION_FORMAT = /^[a-f0-9]{32}$/;

/*
 * This id is the only thing protecting a visitor's medication list, so it is 128
 * bits from the browser's cryptographic generator. It used to be Math.random() in
 * base 36, roughly 41 bits from a generator documented as unsuitable for secrets,
 * with a timestamp on the end. An id saved by the old code no longer matches the
 * format and is quietly replaced; whatever it held expires on its own.
 */
const session = (() => {
  let id = null;
  try { id = localStorage.getItem(SESSION_KEY); } catch { /* private mode */ }
  if (!id || !SESSION_FORMAT.test(id)) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(SESSION_KEY, id); } catch { /* nothing to do */ }
  }
  return id;
})();

/* ------------------------------------------------------------------ *
 * The MCP endpoint. Stateless Streamable HTTP: one POST, one answer,
 * which may come back as JSON or as a single SSE frame.
 * ------------------------------------------------------------------ */

let rpcId = 0;
const latencies = [];

async function callTool(name, args = {}) {
  const started = performance.now();
  const res = await fetch('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-sudor-demo': session,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const ms = Math.round(performance.now() - started);
  const raw = await res.text();

  if (res.status === 401) {
    throw new Error('This server has account linking switched on, so this page cannot call it directly.');
  }
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  let json;
  try {
    json = JSON.parse(line ? line.slice(6) : raw);
  } catch {
    throw new Error(`The server answered with something that is not JSON (HTTP ${res.status}).`);
  }
  if (json.error) throw new Error(json.error.message || 'The tool call failed.');

  latencies.push(ms);
  return {
    ms,
    text: json.result?.content?.[0]?.text ?? '',
    structured: json.result?.structuredContent ?? null,
    result: json.result,
  };
}

/* ------------------------------------------------------------------ *
 * The panel, hosted properly.
 *
 * A view is not allowed to be sent anything until it has asked to start
 * and confirmed, so a result that arrives early is held rather than
 * dropped. That is the bug this page would otherwise have on first load,
 * because the first tool call usually beats the iframe.
 * ------------------------------------------------------------------ */

const frame = el('panel');
let panelReady = false;
let held = null;

const toPanel = (message) => frame.contentWindow?.postMessage({ jsonrpc: '2.0', ...message }, '*');

function showOnPanel(payload) {
  if (!panelReady) { held = payload; return; }
  toPanel({ method: 'ui/notifications/tool-result', params: payload });
}

window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow) return;
  const m = event.data;
  if (!m || m.jsonrpc !== '2.0') return;

  if (m.method === 'ui/initialize') {
    toPanel({
      id: m.id,
      result: {
        protocolVersion: '2026-01-26',
        hostContext: { theme: currentTheme(), displayMode: 'inline' },
      },
    });
    return;
  }
  if (m.method === 'ui/notifications/initialized') {
    panelReady = true;
    if (held) { showOnPanel(held); held = null; }
    return;
  }
  if (m.method === 'ui/notifications/size-changed') {
    const h = Number(m.params?.height);
    if (Number.isFinite(h)) frame.style.height = `${Math.min(560, Math.max(260, Math.round(h) + 8))}px`;
  }
});

/* ------------------------------------------------------------------ *
 * Theme. The panel follows the page, through the same notification a
 * real host would send when someone switches an Echo Show to night mode.
 * ------------------------------------------------------------------ */

function currentTheme() {
  const set = document.documentElement.getAttribute('data-theme');
  if (set === 'dark' || set === 'light') return set;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* nothing to do */ }
  const toggle = el('theme-toggle');
  toggle.textContent = theme === 'dark' ? 'Light' : 'Dark';
  toggle.setAttribute('aria-pressed', String(theme === 'dark'));
  toPanel({ method: 'ui/notifications/host-context-changed', params: { theme } });
}

/* ------------------------------------------------------------------ *
 * The requests on offer. Every one is a real tool with real arguments,
 * written the way the person would say it out loud.
 * ------------------------------------------------------------------ */

/*
 * The catalogue lives in requests.json rather than here, so a test can call
 * every request this page offers and fail if any button points at a tool or an
 * argument the server does not accept. A demo that quietly breaks is worse than
 * no demo.
 */
const nextFriday = (() => {
  const d = new Date();
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
})();

const catalogue = await fetch('/requests.json').then((r) => r.json());
const fill = (value) => JSON.parse(JSON.stringify(value).replaceAll('{{next-friday}}', nextFriday));

const GROUPS = fill(catalogue.groups);
const ALL_TOOLS = catalogue.tools;
const SEED = catalogue.seed;

/*
 * A few requests ask for tools the server only publishes when its full scope is switched on (SECONDARY_TOOLS on
 * the server). On the default server those buttons answered "I can't do that one", so a request marked secondary
 * is offered only when the server's own tools/list has it. Everything else is offered as before, including the
 * tools folded into another one, which are callable though not listed.
 */
async function listedTools() {
  try {
    const res = await fetch('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-sudor-demo': session },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} }),
    });
    const raw = await res.text();
    const line = raw.split('\n').find((l) => l.startsWith('data: '));
    const json = JSON.parse(line ? line.slice(6) : raw);
    return new Set((json.result?.tools ?? []).map((t) => t.name));
  } catch {
    return new Set();
  }
}
const LISTED = await listedTools();
const SECONDARY = new Set(GROUPS.flatMap((g) => g.requests).filter((r) => r.secondary).map((r) => r.tool));
const offered = (tool) => !SECONDARY.has(tool) || LISTED.has(tool);

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderAnswer({ text, ms, tool, structured, result }) {
  const answer = el('answer');
  answer.classList.remove('waiting');
  answer.textContent = text || 'The tool answered with no spoken text.';
  el('answer-meta').innerHTML =
    `${tool} <span class="${ms > 400 ? 'slow' : 'ok'}">${ms} ms</span>`;
  const rawWrap = el('raw-wrap');
  rawWrap.hidden = false;
  el('raw').textContent = JSON.stringify(result ?? { text, structured }, null, 2);
  if (structured) showOnPanel({ content: [{ type: 'text', text }], structuredContent: structured });
}

function renderFailure(tool, message) {
  const answer = el('answer');
  answer.classList.remove('waiting');
  answer.textContent = message;
  el('answer-meta').innerHTML = `${tool} <span class="slow">failed</span>`;
}

function pushLog(tool, ms, ok) {
  const log = el('log');
  const empty = log.querySelector('.log-empty');
  if (empty) empty.remove();
  const li = document.createElement('li');
  li.innerHTML = `<span>${tool}</span><span class="${ok ? 'ms' : 'failed'}">${ok ? `${ms} ms` : 'failed'}</span>`;
  log.prepend(li);
  while (log.children.length > 8) log.lastElementChild.remove();
  updateLatencyStat();
}

function updateLatencyStat() {
  if (!latencies.length) return;
  const sorted = [...latencies].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  el('stat-latency').innerHTML = `${median} <small>ms median</small>`;
}

// Set once the browser's own profile exists. A click that came first was answered for nobody.
let ready = null;

async function run(tool, args, button) {
  if (ready) await ready;
  if (button) { button.disabled = true; button.setAttribute('aria-pressed', 'true'); }
  document.querySelectorAll('.request[aria-pressed="true"]').forEach((b) => {
    if (b !== button) b.setAttribute('aria-pressed', 'false');
  });
  const answer = el('answer');
  answer.classList.add('waiting');
  answer.textContent = 'Asking the server.';
  try {
    const out = await callTool(tool, args);
    renderAnswer({ ...out, tool });
    pushLog(tool, out.ms, true);
    return out;
  } catch (err) {
    renderFailure(tool, err.message);
    pushLog(tool, 0, false);
    return null;
  } finally {
    if (button) button.disabled = false;
  }
}

function buildRequests() {
  const host = el('request-groups');
  host.textContent = '';
  for (const group of GROUPS) {
    const requests = group.requests.filter((r) => offered(r.tool));
    if (!requests.length) continue;
    const wrap = document.createElement('div');
    wrap.className = 'group';
    const heading = document.createElement('p');
    heading.className = 'label';
    heading.textContent = group.name;
    wrap.append(heading);
    for (const req of requests) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'request';
      button.setAttribute('aria-pressed', 'false');
      button.innerHTML = `<span>${req.say}</span><span class="tool">${req.tool}</span>`;
      if (req.slow) button.title = 'This one reaches the Kp archive for an old date, so it takes longer.';
      button.addEventListener('click', () => run(req.tool, req.args, button));
      wrap.append(button);
    }
    host.append(wrap);
  }

  const select = el('adv-tool');
  for (const tool of ALL_TOOLS.filter(offered)) {
    const option = document.createElement('option');
    option.value = tool;
    option.textContent = tool;
    select.append(option);
  }
}

/* ------------------------------------------------------------------ *
 * Setting up this browser's farm, once.
 * ------------------------------------------------------------------ */

const PROFILE_NOTE =
  `Stand-in profile, not a real person: ${SEED.location.place}, taking ${SEED.medications.join(' and ')}, living ` +
  `with ${SEED.conditions.join(' and ')}. Use your own location and the weather half becomes real for you. ` +
  'The medicines stay a stand-in, because nobody should type their prescriptions into a web page.';

/** Replace the stand-in place with the visitor's real coordinates. */
async function useMyLocation() {
  const note = el('profile-note');
  const button = el('use-location');
  button.disabled = true;
  button.textContent = 'Asking your browser...';
  const where = await askForLocation();
  if (!where) {
    button.disabled = false;
    button.textContent = 'Use my location';
    note.textContent = `${PROFILE_NOTE} Your browser did not share a location, so the stand-in place is still in use.`;
    return;
  }
  await callTool('register_location', { place: 'your location', lat: where.lat, lon: where.lon });
  note.textContent =
    `Now using your own coordinates, ${where.lat}, ${where.lon}, with the stand-in medicines still on the list. ` +
    'The heat, cold, air and warnings below are the real ones where you are.';
  button.textContent = 'Added';
  setTimeout(() => void refreshNow(), 2500);
}

async function ensureProfile() {
  const note = el('profile-note');
  try {
    const profile = await callTool('my_profile');
    if (profile.structured && profile.structured.location) {
      note.textContent = PROFILE_NOTE;
      return;
    }
    note.textContent = 'Setting up a profile for this browser.';
    await callTool('register_location', SEED.location);
    for (const name of SEED.medications) await callTool('medication', { action: 'add', name });
    for (const condition of SEED.conditions) await callTool('health_condition', { action: 'add', condition });
    note.textContent = PROFILE_NOTE;
    // The place is looked up in the background, because geocoding on its own
    // costs most of a voice turn, so the first weather answer lands a moment
    // after the profile does.
    setTimeout(() => { void refreshNow(); }, 2500);
  } catch (err) {
    note.textContent = `Could not set up the stand-in profile. ${err.message}`;
  }
}

const STATUS_WORD = { good: 'fine to be out', caution: 'take care', avoid: 'better inside' };

async function refreshNow(tries = 0) {
  try {
    const out = await callTool('weather_check');
    const s = out.structured ?? {};
    if (s.unavailable) {
      // A first visit asks a moment before the forecast for the demo address has arrived. The boxes used to stay
      // on "checking" for good, under the server's "ask me again in a moment"; this asks again instead.
      if (tries < 10) {
        el('stats-note').textContent = 'Fetching the live forecast for the stand-in address…';
        setTimeout(() => void refreshNow(tries + 1), 3000);
      } else {
        el('stats-note').textContent = 'The live forecast is slow to arrive. The examples below still work.';
      }
      return;
    }
    el('stat-hi').innerHTML =
      typeof s.heatIndexF === 'number' ? `${Math.round(s.heatIndexF)}<small> F</small>` : 'unknown';
    el('stat-status').textContent = STATUS_WORD[s.status] || 'unknown';
    el('stat-uv').textContent = typeof s.uvIndex === 'number' ? s.uvIndex.toFixed(1) : 'unknown';
    el('stats-note').textContent = s.place
      ? `Live for ${s.place}, not a recording.`
      : 'Live from this server, not a recording.';
    // Put real weather on the panel straight away, rather than leaving it on its
    // labelled example until the visitor clicks something.
    if (out.structured) showOnPanel({ content: [{ type: 'text', text: out.text }], structuredContent: out.structured });
    updateLatencyStat();
  } catch (err) {
    el('stats-note').textContent = `Could not reach the server. ${err.message}`;
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

let stored = null;
try { stored = localStorage.getItem(THEME_KEY); } catch { /* private mode */ }
if (stored === 'dark' || stored === 'light') setTheme(stored);
else el('theme-toggle').textContent = currentTheme() === 'dark' ? 'Light' : 'Dark';

el('theme-toggle').addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));

el('adv-run').addEventListener('click', async () => {
  const tool = el('adv-tool').value;
  let args;
  try {
    args = JSON.parse(el('adv-args').value || '{}');
  } catch {
    renderFailure(tool, 'Those arguments are not valid JSON.');
    return;
  }
  await run(tool, args, null);
});

el('use-location').addEventListener('click', () => void useMyLocation());

el('reset-demo').addEventListener('click', () => {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* nothing to do */ }
  location.reload();
});

buildRequests();
ready = ensureProfile();
await ready;
await refreshNow();

/*
 * The Alexa+ stand-in.
 *
 * Posts an utterance to /agent, which asks a model to choose a tool from this
 * server's own published tools/list and then executes the choice over MCP.
 *
 * Both halves are shown, deliberately. The chosen tool and arguments are the
 * interesting part: they are what a real host would have had to work out from the
 * tool descriptions, and seeing them wrong is more informative than seeing a
 * plausible answer. A decline is rendered as a result, not as a failure, because
 * a host that calls nothing when nothing fits is behaving correctly.
 */
const standInForm = el('standin-form');
if (standInForm) {
  const input = el('standin-input');
  const out = el('standin-out');
  const go = el('standin-go');

  const write = (html) => { out.innerHTML = html; };
  // The conversation so far, sent with each sentence. See conversation() in standin.ts.
  const turns = [];
  // The next step the last answer named, so a bare "yes" can take it. See bareAnswer() in rules.ts.
  let next = null;
  const esc = (v) =>
    String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  standInForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const say = input.value.trim();
    if (!say) return;

    go.disabled = true;
    write('<p class="thinking">Choosing a tool...</p>');
    const started = Date.now();

    try {
      const res = await fetch('/agent', {
        method: 'POST',
        // The identity matters: without it the stand-in ran as one shared profile,
        // so a medication one visitor added was visible to the next.
        headers: { 'content-type': 'application/json', 'x-sudor-demo': session },
        body: JSON.stringify({ say, history: turns, next }),
      });
      const body = await res.json();
      const roundTrip = Date.now() - started;

      if (res.status === 503) {
        write(`<p class="muted">${esc(body.detail ?? 'The stand-in is not configured.')}</p>`);
        return;
      }
      if (!res.ok) {
        write(`<p class="bad">${esc(body.detail ?? 'The stand-in failed.')}</p>`);
        return;
      }

      // Declined: no tool fitted. Shown as an outcome.
      if (!body.chose) {
        write(
          `<p class="chose">Chose <strong>no tool</strong>, because nothing fitted.</p>` +
          (body.said ? `<p class="answer">${esc(body.said)}</p>` : '') +
          `<p class="muted">${esc(body.model)}  |  ${body.ms} ms to decide  |  ${roundTrip} ms total</p>`
        );
        return;
      }

      const text = body.reply || body.result?.content?.[0]?.text || '(no text)';
      next = body.result?.structuredContent?.nextAction ?? null;
      const chain = (body.steps ?? []).map((s) => s.tool).join(' then ');
      write(
        `<p class="chose">Chose <strong>${esc(chain || body.chose.tool)}</strong> with ` +
        `<code>${esc(JSON.stringify(body.chose.args))}</code></p>` +
        `<p class="answer">${esc(text)}</p>` +
        `<p class="muted">${esc(body.model)}  |  ${body.ms} ms to decide  |  ${roundTrip} ms total  |  ` +
        `${esc(body.standIn)}</p>`
      );
      // The answer is the thing worth hearing, not the tool name.
      // Kept for the next sentence, as Alexa+ keeps the conversation: "no" means something after a question.
      turns.push({ role: 'user', text: say }, { role: 'assistant', text });
      turns.splice(0, Math.max(0, turns.length - 6));
      offerSpeech(out, text);
    } catch (err) {
      write(`<p class="bad">${esc(String(err))}</p>`);
    } finally {
      go.disabled = false;
    }
  });
}

/*
 * Hearing it.
 *
 * Every sentence this server produces is written to be heard once, by someone
 * with their hands busy, who cannot scroll back. Rendering it as text hides the
 * one property the whole thing is designed around, and long numbers are where
 * that shows: a ratio that reads fine is a lot to hold in your head at the speed
 * of speech.
 *
 * Off unless the server has ORBITA_SPEAK=on, and the button simply does not
 * appear in that case rather than appearing and failing.
 */
let speechAvailable = null;

async function canSpeak() {
  if (speechAvailable !== null) return speechAvailable;
  try {
    const res = await fetch('/health');
    const body = await res.json();
    speechAvailable = body?.speech?.on === true;
  } catch {
    speechAvailable = false;
  }
  return speechAvailable;
}

let playing = null;

/** Attach a play control to a container holding a spoken sentence. */
async function offerSpeech(container, text) {
  if (!container || !text || !(await canSpeak())) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost speak';
  button.textContent = 'Hear it';
  // Named for a screen reader, which would otherwise read only "Hear it" with no
  // indication of what would be heard.
  button.setAttribute('aria-label', 'Hear this answer spoken');

  button.addEventListener('click', async () => {
    if (playing) { playing.pause(); playing = null; }
    button.disabled = true;
    button.textContent = 'Loading';
    try {
      const res = await fetch('/speak', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sudor-demo': session },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) { button.textContent = 'Unavailable'; return; }
      const blob = await res.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      playing = audio;
      button.textContent = 'Playing';
      audio.addEventListener('ended', () => {
        button.textContent = 'Hear it';
        button.disabled = false;
        playing = null;
      });
      await audio.play();
    } catch {
      button.textContent = 'Unavailable';
    } finally {
      if (button.textContent !== 'Playing') button.disabled = false;
    }
  });

  container.appendChild(button);
}
