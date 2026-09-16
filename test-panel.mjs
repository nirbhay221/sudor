/**
 * The Echo Show panel, run the way an MCP Apps host runs it: the view must say
 * ui/initialize, wait for the answer, confirm with ui/notifications/initialized,
 * and only then will a host send it the tool result.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

const html = readFileSync('./ui/window.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

function boot({ embedded = true } = {}) {
  const els = new Map();
  const element = (id) => {
    if (!els.has(id)) {
      els.set(id, { id, textContent: '', innerHTML: '', className: '', hidden: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
    }
    return els.get(id);
  };
  const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, scrollWidth: 420, scrollHeight: 300 };
  const sent = [];
  const listeners = [];
  const window = { addEventListener: (_t, fn) => listeners.push(fn) };
  window.parent = embedded ? { postMessage: (m) => sent.push(JSON.parse(JSON.stringify(m))) } : window;
  const deliver = (data) => listeners.forEach((fn) => fn({ data }));
  vm.runInNewContext(script, {
    window, document: { getElementById: element, documentElement: root },
    setTimeout, clearTimeout, Promise, Date, Math, JSON, String, Number, Array, Object, Map, console,
  });
  return { els, root, sent, deliver };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

console.log('\nNo em dashes on screen');
check('no em dash characters or entities in the panel', !/&mdash;|\u2014|\u2013/.test(html));

console.log('\nAt rest, before any host speaks');
const host = boot();
check('an example day is on screen, labelled as an example', /Example/.test(host.els.get('place').textContent));
check('every hour carries a word, not just a colour', /stay in/.test(host.els.get('strip').innerHTML) && /ok/.test(host.els.get('strip').innerHTML));

console.log('\nThe handshake');
const init = host.sent[0];
check('the first message is ui/initialize with an id', init?.method === 'ui/initialize' && init?.id != null, JSON.stringify(init));
check('...on the 2026-01-26 apps protocol, declaring inline and fullscreen',
  init?.params?.protocolVersion === '2026-01-26' &&
  JSON.stringify(init?.params?.appCapabilities?.availableDisplayModes) === JSON.stringify(['inline', 'fullscreen']));
check('it does not claim to be initialized before the host answers', !host.sent.some((m) => m.method === 'ui/notifications/initialized'));
host.deliver({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: '2026-01-26', hostContext: { theme: 'dark' } } });
await tick();
check('once answered, it confirms with ui/notifications/initialized', host.sent.some((m) => m.method === 'ui/notifications/initialized'));
check('...and follows the host theme', host.root.attrs['data-theme'] === 'dark');

console.log('\nReal results replace the example');
host.deliver({
  jsonrpc: '2.0', method: 'ui/notifications/tool-result',
  params: { content: [], structuredContent: { heatIndexF: 104.5, category: 'danger', status: 'avoid', because: 'with multiple sclerosis', place: 'Phoenix, Arizona' } },
});
check('a heat check shows the heat index', host.els.get('hi').textContent === '105°F', host.els.get('hi').textContent);
check('...and the verdict in words', host.els.get('chip').textContent === 'Better inside');
check('...and why it was judged that way', /multiple sclerosis/.test(host.els.get('why').textContent));
host.deliver({
  jsonrpc: '2.0', method: 'ui/notifications/tool-result',
  params: {
    content: [],
    structuredContent: {
      place: 'Tucson, Arizona',
      hours: [{ local: '2026-09-14T06:00', heatIndexF: 78, status: 'good' }, { local: '2026-09-14T13:00', heatIndexF: 103, status: 'avoid' }],
      best: { label: '6 to 7 am' }, worst: { label: '1 to 2 pm' },
    },
  },
});
check('a day plan fills the hourly strip and the best and avoid spans',
  /6a/.test(host.els.get('strip').innerHTML) && host.els.get('best').textContent === '6 to 7 am' && host.els.get('avoid').textContent === '1 to 2 pm');
check('...and tells the host its new size', host.sent.some((m) => m.method === 'ui/notifications/size-changed'));

console.log('\nOutside a host');
const alone = boot({ embedded: false });
check('standing alone it sends nothing and keeps the example', alone.sent.length === 0 && /Example/.test(alone.els.get('place').textContent));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
