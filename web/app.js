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
const session = (() => {
  let id = null;
  try { id = localStorage.getItem(SESSION_KEY); } catch { /* private mode */ }
  if (!id || !/^[a-z0-9-]{8,64}$/.test(id)) {
    id = 'd' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
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
    throw new Error('This server has account linking switched on, so the demo page cannot call it directly.');
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

async function run(tool, args, button) {
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
    const wrap = document.createElement('div');
    wrap.className = 'group';
    const heading = document.createElement('p');
    heading.className = 'label';
    heading.textContent = group.name;
    wrap.append(heading);
    for (const req of group.requests) {
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
  for (const tool of ALL_TOOLS) {
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
  `${SEED.location.place}, taking ${SEED.medications.join(' and ')}, living with ${SEED.conditions.join(' and ')}. ` +
  'This profile belongs to your browser alone, and the requests below can change it.';

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
    for (const name of SEED.medications) await callTool('register_medication', { name });
    for (const condition of SEED.conditions) await callTool('register_condition', { condition });
    note.textContent = PROFILE_NOTE;
    // The place is looked up in the background, because geocoding on its own
    // costs most of a voice turn, so the first weather answer lands a moment
    // after the profile does.
    setTimeout(() => { void refreshNow(); }, 2500);
  } catch (err) {
    note.textContent = `Could not set up the demo profile. ${err.message}`;
  }
}

const STATUS_WORD = { good: 'fine to be out', caution: 'take care', avoid: 'better inside' };

async function refreshNow() {
  try {
    const out = await callTool('heat_check');
    const s = out.structured ?? {};
    if (s.unavailable) {
      el('stats-note').textContent = out.text;
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

el('reset-demo').addEventListener('click', () => {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* nothing to do */ }
  location.reload();
});

buildRequests();
await ensureProfile();
await refreshNow();
