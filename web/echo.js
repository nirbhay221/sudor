/**
 * The Echo-style demo page.
 *
 * A screen, the lines somebody might say to it, and the phone of the person who gets told. Every line is a
 * real tool call to this server. No assistant model runs here, so the lines are fixed and listed in
 * echo-scenes.json; what comes back is whatever the server says today, for the profile built on this page.
 *
 * The phone shows what a contact would have been emailed. The public demo never sends email, so the server
 * keeps those messages against this browser's own sandbox id and this page reads them back. The buttons on a
 * message post to the same pages a link in a real email opens.
 */

const SESSION_KEY = 'sudor.demo.session';
const SESSION_FORMAT = /^[0-9a-f]{32}$/;
const el = (id) => document.getElementById(id);

function newSession() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}
let session = null;
try { session = localStorage.getItem(SESSION_KEY); } catch { /* private mode */ }
if (!session || !SESSION_FORMAT.test(session)) {
  session = newSession();
  try { localStorage.setItem(SESSION_KEY, session); } catch { /* nothing to do */ }
}

let rpcId = 0;
async function callTool(name, args) {
  const started = performance.now();
  const res = await fetch('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-sudor-demo': session },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  let json;
  try { json = JSON.parse(line ? line.slice(6) : raw); } catch { throw new Error(`The server answered with something unreadable (HTTP ${res.status}).`); }
  if (json.error) throw new Error(json.error.message || 'The call failed.');
  return { ms: Math.round(performance.now() - started), text: json.result?.content?.[0]?.text ?? '', data: json.result?.structuredContent ?? {} };
}

/* ---------------------------------------------------------------- the screen */

function speak(text) {
  if (!el('voice').checked || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

function showCard(card, enterAt) {
  const box = el('card');
  box.replaceChildren();
  // A page to type an email address on, when the answer handed one back. Opens in a new tab.
  if (enterAt && /^https?:\/\//.test(enterAt)) {
    const a = document.createElement('a');
    a.href = enterAt;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Type the email address here';
    box.append(a);
    box.hidden = false;
    if (!card || card.kind !== 'card') return;
  }
  if (!card || card.kind !== 'card') { if (!enterAt) box.hidden = true; return; }
  const title = document.createElement('h3');
  title.textContent = card.title ?? '';
  box.append(title);
  if (card.status?.label) {
    const s = document.createElement('span');
    s.className = `status ${card.status.tone === 'bad' ? 'bad' : card.status.tone === 'good' ? 'good' : ''}`;
    s.textContent = card.status.label;
    box.append(s);
  }
  const list = document.createElement('ul');
  for (const line of [...(card.lines ?? []), card.confirm, card.foot].filter(Boolean)) {
    const li = document.createElement('li');
    li.textContent = line;
    list.append(li);
  }
  if (list.children.length) box.append(list);
  box.hidden = false;
}

async function say(line, button) {
  const buttons = [...document.querySelectorAll('.chip')];
  buttons.forEach((b) => (b.disabled = true));
  el('heard').classList.remove('idle');
  el('heard').textContent = line.say;
  el('answer').textContent = '…';
  try {
    const r = await callTool(line.tool, line.args ?? {});
    el('answer').textContent = r.text;
    el('meta').textContent = `${line.tool} answered in ${r.ms} ms`;
    showCard(r.data.card, r.data.enterAt);
    speak(r.text);
  } catch (err) {
    el('answer').textContent = err.message;
    el('meta').textContent = '';
    showCard(null);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    button?.focus();
    void readPhone();
  }
}

/* ---------------------------------------------------------------- the phone */

const acted = new Map();

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  return res.ok;
}

function action(label, cls, run, key, done) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `act ${cls}`;
  b.textContent = label;
  b.addEventListener('click', async () => {
    b.disabled = true;
    const ok = await run();
    acted.set(key, ok ? done : 'That link no longer works.');
    void readPhone();
  });
  return b;
}

function renderPhone(messages) {
  const inbox = el('inbox');
  inbox.replaceChildren();
  el('empty').hidden = messages.length > 0;
  for (const m of [...messages].reverse()) {
    const key = `${m.at}|${m.reason}`;
    const li = document.createElement('li');
    const h = document.createElement('h3');
    h.textContent = m.to ? `To ${m.to}: ${m.subject}` : m.subject;
    const p = document.createElement('p');
    p.textContent = m.text;
    li.append(h, p);
    if (acted.has(key)) {
      const d = document.createElement('p');
      d.className = 'done';
      d.textContent = acted.get(key);
      li.append(d);
    } else if (m.accept) {
      li.append(
        action('Yes, send them to me', '', () => post('/contact/accept', { t: m.accept, answer: 'yes' }), key, 'Agreed. Alerts will now reach this phone.'),
        action('No', 'second', () => post('/contact/accept', { t: m.accept, answer: 'no' }), key, 'Declined. Nothing more will be sent.'),
      );
    } else if (m.reply) {
      li.append(
        action("I'm on my way", '', () => post('/contact/reply', { r: m.reply, answer: 'coming' }), key, 'Sent. They hear it the next time they speak.'),
        action('Ask them to ring me', 'second', () => post('/contact/reply', { r: m.reply, answer: 'call' }), key, 'Sent. They hear it the next time they speak.'),
      );
    }
    inbox.append(li);
  }
}

async function readPhone() {
  try {
    const res = await fetch('/demo/phone', { headers: { 'x-sudor-demo': session } });
    if (!res.ok) return;
    renderPhone((await res.json()).messages ?? []);
  } catch { /* the phone simply stays as it was */ }
}

/* ---------------------------------------------------------------- the lines */

async function start() {
  el('heard').classList.add('idle');
  const scenes = await (await fetch('/echo-scenes.json')).json();
  const host = el('lines');
  for (const group of scenes.groups) {
    const box = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = group.name;
    box.append(title);
    for (const line of group.lines) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = line.say;
      b.addEventListener('click', () => void say(line, b));
      box.append(b);
    }
    host.append(box);
  }
  el('reset').addEventListener('click', () => {
    try { localStorage.setItem(SESSION_KEY, newSession()); } catch { /* nothing to do */ }
    location.reload();
  });
  void readPhone();
}

void start();

/* ---------------------------------------------------------------- say anything */

/*
 * Say anything, by typing or with the microphone.
 *
 * The sentence goes to /agent, where a model reads this server's own tool list and picks a tool, the way
 * Alexa+ would; with no model available the server's word rules pick instead. Either way the page shows
 * which tool was chosen and by what, so it is clear what was decided and what was answered. Speech in and
 * out is the browser's own (Chrome and Edge hear; most browsers speak), so nothing about the voice leaves
 * the visitor's machine except the words.
 */
// The conversation so far and the next step the last answer named, sent with each sentence.
const echoTurns = [];
let echoNext = null;
async function sayAnything(words, button) {
  const buttons = [...document.querySelectorAll('.chip, #free button')];
  buttons.forEach((b) => (b.disabled = true));
  el('heard').classList.remove('idle');
  el('heard').textContent = words;
  el('answer').textContent = '…';
  try {
    const res = await fetch('/agent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sudor-demo': session }, body: JSON.stringify({ say: words, history: echoTurns, next: echoNext }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail || `The server said no (HTTP ${res.status}).`);
    const text = body.reply || body.result?.content?.[0]?.text || body.said || '';
    // Kept for the next sentence, as Alexa+ keeps the conversation. See conversation() in standin.ts.
    echoTurns.push({ role: 'user', text: words }, { role: 'assistant', text });
    echoTurns.splice(0, Math.max(0, echoTurns.length - 6));
    echoNext = body.result?.structuredContent?.nextAction ?? null;
    el('answer').textContent = text;
    const by = body.model === 'word rules' ? 'word rules (no model running)' : body.model;
    el('meta').textContent = body.chose ? `${by} chose ${(body.steps ?? [body.chose]).map((s) => s.tool).join(' then ')}` : `${by} chose no tool`;
    showCard(body.result?.structuredContent?.card, body.result?.structuredContent?.enterAt);
    speak(text);
  } catch (err) {
    el('answer').textContent = err.message;
    el('meta').textContent = '';
    showCard(null);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    button?.focus();
    if (typeof readPhone === 'function') void readPhone();
  }
}

function setUpFree() {
  const form = el('free');
  if (!form) return;
  const box = el('free-text');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const words = box.value.trim();
    if (words) void sayAnything(words, form.querySelector('button[type=submit]'));
  });
  const Hear = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = el('mic');
  if (!Hear) { mic.hidden = true; return; }
  mic.addEventListener('click', () => {
    const r = new Hear();
    r.lang = 'en-US';
    r.interimResults = false;
    mic.textContent = 'Listening…';
    mic.disabled = true;
    r.onresult = (ev) => {
      const words = ev.results[0][0].transcript;
      box.value = words;
      void sayAnything(words, mic);
    };
    r.onend = () => { mic.textContent = 'Speak'; mic.disabled = false; };
    r.onerror = () => { mic.textContent = 'Speak'; mic.disabled = false; };
    r.start();
  });
}
setUpFree();
