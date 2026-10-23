/**
 * The Echo-style demo page.
 *
 * A screen, the lines somebody might say to it, and the phone of the person who gets told. Every line is a
 * real tool call to this server. No assistant model runs on them, so the lines are fixed and listed in
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

// The idle screen shows the time and a greeting, as an Echo Show does; the phone shows the same time.
function tick() {
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  for (const id of ['clock', 'sclock', 'ptime']) if (el(id)) el(id).textContent = time;
  const h = now.getHours();
  if (el('greet')) el('greet').textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
tick();
setInterval(tick, 20000);

// Light or dark: the system's choice until the button is pressed, then the visitor's, remembered here.
el('theme')?.addEventListener('click', () => {
  const root = document.documentElement;
  const now = root.dataset.theme || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  root.dataset.theme = now === 'light' ? 'dark' : 'light';
  try { localStorage.setItem('echo.theme', root.dataset.theme); } catch { /* private mode */ }
});

// Once anything is said, the screen swaps the clock for the conversation.
function goLive() {
  const screen = el('screen');
  screen?.classList.add('live');
  // On a narrow screen the lines sit below the device, so bring the answer back into view.
  if (screen && window.matchMedia('(max-width: 60rem)').matches) screen.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Behind the answer: every tool call, newest first, with how long it took.
function trace(what, detail) {
  const list = el('trace');
  if (!list) return;
  const li = document.createElement('li');
  const a = document.createElement('span');
  a.textContent = what;
  const b = document.createElement('span');
  b.textContent = detail;
  li.append(a, b);
  list.prepend(li);
  while (list.children.length > 6) list.lastChild.remove();
  el('trace-empty').hidden = true;
}

// When the question is about: now, or tomorrow. Sudor reads live weather and the forecast, not past days.
/*
 * When the question is about. null is now; otherwise tomorrow, one day (any day back to 1940, or up to six days
 * ahead), or a stretch: the week ahead, or the last week, month or year. It used to be now or tomorrow and nothing
 * else, and there was no way to ask about last Tuesday or the week ahead from the controls.
 */
let when = null;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayYmd = () => ymd(new Date());
const dayWords = (date) => {
  const d = new Date(`${date}T12:00:00`);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
};
const PERIOD_WORDS = { 'next-week': 'the week ahead', week: 'the last 7 days', month: 'the last 30 days', year: 'the last year' };
function whenLabel() {
  if (!when) return '';
  if (when.kind === 'tomorrow') return 'tomorrow';
  if (when.kind === 'period') return PERIOD_WORDS[when.period];
  return dayWords(when.date);
}
function forWhen(tool, args) {
  if (!when) return [tool, args];
  const dayTools = ['plan_my_day', 'weather_check', 'going_out_now'];
  if (when.kind === 'tomorrow') {
    if (tool === 'plan_my_day') return [tool, { ...args, day: 'tomorrow' }];
    if (tool === 'weather_check' || tool === 'going_out_now') return ['plan_my_day', { day: 'tomorrow' }];
    return [tool, args];
  }
  if (!dayTools.includes(tool)) return [tool, args];
  const keep = tool === 'plan_my_day' ? { ...(args.activity ? { activity: args.activity } : {}), ...(args.minutes ? { minutes: args.minutes } : {}) } : {};
  if (when.kind === 'period') return when.period === 'next-week' ? ['plan_my_week', keep] : ['heat_patterns', { period: when.period }];
  const today = todayYmd();
  if (when.date === today) return [tool, args];
  return when.date > today ? ['plan_my_week', { ...keep, date: when.date }] : ['heat_patterns', { date: when.date }];
}

// A day named in the words wins over the date button. "Is it safe today?" with Tomorrow pressed used to go out as
// "Is it safe today? I mean tomorrow.", two days in one question. A calendar date in a scripted line, or any day
// word in a typed one, is sent as it was said, and the button only fills in when the words name no day.
const CALENDAR = /\b((jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}|\d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*|(19|20)\d\d|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})\b/i;
const DAY_WORD = /\b(today|tonight|tomorrow|yesterday|this (morning|afternoon|evening|weekend)|next (week|month|\w+day)|(mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;
const namesADay = (words) => CALENDAR.test(words) || DAY_WORD.test(words);
const whenNote = (words) => (when && !namesADay(words) ? ` (${whenLabel()})` : '');
const whenWords = (words) => {
  if (!when || namesADay(words)) return words;
  if (when.kind === 'tomorrow') return `${words} I mean tomorrow.`;
  if (when.kind === 'period') return when.period === 'next-week' ? `${words} I mean over the week ahead.` : `${words} I mean over ${PERIOD_WORDS[when.period]}.`;
  return `${words} I mean on ${dayWords(when.date)}.`;
};

function setUpWhen() {
  const now = el('when-now');
  const next = el('when-tomorrow');
  const pick = el('when-pick');
  const panel = el('when-panel');
  const dateBox = el('when-date');
  const readout = el('when-readout');
  if (!now || !next) return;
  const presets = panel ? [...panel.querySelectorAll('.preset')] : [];
  const pressed = (which) => {
    now.setAttribute('aria-pressed', String(which === 'now'));
    next.setAttribute('aria-pressed', String(which === 'tomorrow'));
    pick?.setAttribute('aria-pressed', String(which === 'pick'));
    if (panel) panel.hidden = which !== 'pick';
  };
  const tell = () => {
    if (!readout) return;
    if (!when || when.kind === 'tomorrow') { readout.textContent = 'Pick a choice above, or a day.'; return; }
    if (when.kind === 'period') { readout.textContent = when.period === 'next-week' ? 'Asking about the week ahead: which days are fine, careful or stay-in for you.' : `Looking back over ${PERIOD_WORDS[when.period]}: the days that were too hot or too cold for you.`; return; }
    const today = todayYmd();
    readout.textContent = when.date === today ? 'Asking about today.' : when.date > today ? `Planning ${dayWords(when.date)}: the best hours and the ones to avoid, for you.` : `Looking back at ${dayWords(when.date)}: how hot or cold it got, and the hours that were too much for you.`;
  };
  if (dateBox) {
    dateBox.min = '1940-01-01';
    const max = new Date(); max.setDate(max.getDate() + 6);
    dateBox.max = ymd(max);
    dateBox.addEventListener('change', () => {
      presets.forEach((p) => p.setAttribute('aria-pressed', 'false'));
      when = dateBox.value ? { kind: 'day', date: dateBox.value } : null;
      tell();
    });
  }
  for (const p of presets) {
    p.addEventListener('click', () => {
      presets.forEach((o) => o.setAttribute('aria-pressed', String(o === p)));
      if (dateBox) dateBox.value = '';
      when = { kind: 'period', period: p.dataset.period };
      tell();
    });
  }
  now.addEventListener('click', () => { pressed('now'); when = null; });
  next.addEventListener('click', () => { pressed('tomorrow'); when = { kind: 'tomorrow' }; });
  pick?.addEventListener('click', () => {
    pressed('pick');
    presets.forEach((o) => o.setAttribute('aria-pressed', String(o.dataset.period === 'next-week')));
    if (dateBox) dateBox.value = '';
    when = { kind: 'period', period: 'next-week' };
    tell();
  });
}
setUpWhen();

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
  goLive();
  el('heard').classList.remove('idle');
  el('heard').textContent = !when ? line.say : when.kind === 'tomorrow' ? line.say.replace(/\bright now\b|\btoday\b/i, 'tomorrow') : `${line.say.replace(/\bright now\b|\btoday\b/i, 'then')} (${whenLabel()})`;
  el('answer').textContent = '…';
  try {
    const [tool, args] = CALENDAR.test(line.say) ? [line.tool, line.args ?? {}] : forWhen(line.tool, line.args ?? {});
    const r = await callTool(tool, args);
    el('answer').textContent = r.text;
    el('meta').textContent = `${tool} answered in ${r.ms} ms`;
    trace(tool, `${r.ms} ms`);
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
  if (!String(words ?? '').trim()) return;
  const buttons = [...document.querySelectorAll('.chip, #free button')];
  buttons.forEach((b) => (b.disabled = true));
  goLive();
  el('heard').classList.remove('idle');
  el('heard').textContent = words + whenNote(words);
  el('answer').textContent = '…';
  const sent = whenWords(words);
  try {
    const res = await fetch('/agent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sudor-demo': session }, body: JSON.stringify({ say: sent, history: echoTurns, next: echoNext }) });
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
    for (const step of [...(body.steps ?? (body.chose ? [body.chose] : []))].reverse()) trace(step.tool, `chosen by ${body.model === 'word rules' ? 'word rules' : 'the model'}`);
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
  const label = mic.querySelector('.mic-label');
  /*
   * Listening, done the way a person speaks. The browser's recogniser used to stop at the first pause, or on a
   * cough, and could end with nothing heard; that empty text was sent and the server refused it (HTTP 400). Now it
   * keeps listening, shows the words in the box as they come, stops after about a second and a half of quiet or a
   * second press, sends only words, and says why when it could not hear.
   */
  let r = null;
  let heard = '';
  let quiet = null;
  const WHY = {
    'not-allowed': 'The microphone is blocked. Allow it for this page in the browser, or type instead.',
    'service-not-allowed': 'The microphone is blocked. Allow it for this page in the browser, or type instead.',
    'no-speech': "I didn't hear anything. Press the microphone and speak, or type instead.",
    'audio-capture': 'No microphone was found. Type instead.',
    network: "The browser's speech service could not be reached. Type instead.",
  };
  const stop = () => { if (r) r.stop(); };
  const reset = () => { r = null; clearTimeout(quiet); label.textContent = 'Speak'; mic.setAttribute('aria-label', 'Speak'); mic.classList.remove('listening'); };
  mic.addEventListener('click', () => {
    if (r) { stop(); return; }
    heard = '';
    r = new Hear();
    r.lang = 'en-US';
    r.continuous = true;
    r.interimResults = true;
    label.textContent = 'Listening… press again to stop';
    mic.setAttribute('aria-label', 'Listening. Press again to stop');
    mic.classList.add('listening');
    r.onresult = (ev) => {
      let final = '';
      let interim = '';
      for (let i = 0; i < ev.results.length; i += 1) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) final += t; else interim += t;
      }
      heard = (final + ' ' + interim).replace(/\s+/g, ' ').trim();
      box.value = heard;
      clearTimeout(quiet);
      quiet = setTimeout(stop, 1500);
    };
    r.onerror = (ev) => {
      if (ev.error === 'aborted') return;
      const why = WHY[ev.error];
      if (why) { el('heard').classList.remove('idle'); el('screen')?.classList.add('live'); el('heard').textContent = ''; el('answer').textContent = why; el('meta').textContent = ''; }
    };
    r.onend = () => {
      const words = heard.trim();
      reset();
      if (words) void sayAnything(words, mic);
    };
    try { r.start(); } catch { reset(); }
  });
}
setUpFree();

/* ---------------------------------------------------------------- lines played from a link */

/*
 * A link can carry what to say: /echo.html?say=I+live+in+Phoenix...&say=Is+it+safe+for+me+to+go+out%3F
 * The README's "try it" links use this, so a reader lands on the live server with the line already being said.
 * Each link starts its own profile, so the answer is the one the README describes and not one shaped by whatever this
 * browser said before. At most three lines, the stand-in's burst for one caller, each through the same model as a
 * typed sentence. The query is taken off the address first, so a reload does not say it again.
 */
async function playFromLink() {
  const lines = new URLSearchParams(location.search).getAll('say').map((s) => s.trim().slice(0, 300)).filter(Boolean).slice(0, 3);
  if (!lines.length) return;
  history.replaceState(null, '', location.pathname);
  session = newSession();
  try { localStorage.setItem(SESSION_KEY, session); } catch { /* private mode: this page keeps it in memory */ }
  const box = el('free-text');
  for (const [i, words] of lines.entries()) {
    if (i) await new Promise((r) => setTimeout(r, 2500));
    if (box) box.value = words;
    await sayAnything(words);
  }
  if (box) box.value = '';
  box?.focus();
}
void playFromLink();
