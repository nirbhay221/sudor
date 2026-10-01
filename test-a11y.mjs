/**
 * Accessibility, checked without a browser.
 *
 * Two halves, because one tool cannot do both honestly.
 *
 * 1. Structure, by axe-core against the page's markup in jsdom: names on buttons and form controls, alt text,
 *    landmarks, heading order, ARIA validity, language, labels. jsdom does no layout and no painting, so the
 *    axe rules that depend on what is painted (colour contrast) cannot run there and are switched off, as
 *    axe's own guidance says. Scripts are not run, so this is the markup as served, not as later built.
 *
 * 2. Colour contrast, by arithmetic: the page is themed through CSS custom properties, so the ratio of every
 *    text colour to every background it can sit on is computed from the stylesheet itself, for the light
 *    theme and the dark one, against WCAG 2.x AA (4.5:1 for text).
 *
 * What this does not cover: contrast of anything set outside the tokens, focus visibility, keyboard order
 * and screen-reader output. Those need a browser and a person.
 */
import { readFileSync, existsSync } from 'node:fs';
import { JSDOM } from 'jsdom';

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
};

const axeSource = readFileSync('node_modules/axe-core/axe.min.js', 'utf8');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

async function audit(html) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.eval(axeSource);
  const results = await dom.window.axe.run(dom.window.document, {
    runOnly: { type: 'tag', values: TAGS },
    rules: { 'color-contrast': { enabled: false } },
  });
  dom.window.close();
  return results.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.help} | ${v.nodes[0].target.join(' ').slice(0, 70)}`);
}

console.log('\nThe checker catches what it is there to catch (positive controls)');
const broken = await audit('<!doctype html><html><head><title>t</title></head><body><img src="x.png"><button></button><input type="text"></body></html>');
ok('an image with no alt text is reported', broken.some((v) => v.startsWith('image-alt')), broken.join(' ; '));
ok('a button with no name is reported', broken.some((v) => v.startsWith('button-name')));
ok('a form control with no label is reported', broken.some((v) => v.startsWith('label')));
ok('a page with no language is reported', broken.some((v) => v.startsWith('html-has-lang')));

console.log('\nThe markup we serve');
for (const file of ['web/index.html', 'ui/window.html']) {
  if (!existsSync(file)) { ok(`${file} exists`, false); continue; }
  const html = readFileSync(file, 'utf8');
  const violations = await audit(html);
  ok(`${file} has no axe violations`, violations.length === 0, violations.slice(0, 3).join(' ; '));
  ok(`${file} declares its language`, /<html[^>]*\blang=/.test(html));
}

console.log('\nColour contrast, computed from the stylesheet');
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
ok('control: black on white is 21:1', Math.abs(ratio('#000000', '#ffffff') - 21) < 0.01);
ok('control: a pale grey on white fails 4.5:1', ratio('#cccccc', '#ffffff') < 4.5);

const css = readFileSync('web/styles.css', 'utf8');
const tokens = (block) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]]));
const lightBlock = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
const darkBlock = css.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
const themes = { light: tokens(lightBlock), dark: { ...tokens(lightBlock), ...tokens(darkBlock) } };
ok('both themes were found in the stylesheet', Object.keys(themes.light).length > 5 && Object.keys(themes.dark).length > 5);

const TEXT = ['ink', 'ink-2', 'muted', 'accent', 'accent-deep', 'good', 'bad'];
const GROUND = ['bg', 'surface', 'surface-2'];
for (const [name, t] of Object.entries(themes)) {
  for (const fg of TEXT) {
    for (const bg of GROUND) {
      if (!t[fg] || !t[bg]) continue;
      const r = ratio(t[fg], t[bg]);
      ok(`${name}: ${fg} on ${bg} is at least 4.5:1`, r >= 4.5, `${r.toFixed(2)}:1 (${t[fg]} on ${t[bg]})`);
    }
  }
}

console.log('\nColour contrast of the panel (ui/window.html), computed the same way');
{
  const panel = readFileSync('ui/window.html', 'utf8');
  const lightP = panel.match(/(?:\.viz|:root)\s*\{([\s\S]*?)\n  \}/)?.[1] ?? '';
  const darkP = panel.match(/:root\[data-theme="dark"\][^{]*\{([\s\S]*?)\n  \}/)?.[1] ?? '';
  const panelThemes = { light: tokens(lightP), dark: { ...tokens(lightP), ...tokens(darkP) } };
  ok('both panel themes were found', Object.keys(panelThemes.light).length > 3 && Object.keys(panelThemes.dark).length > 3);
  for (const [name, t] of Object.entries(panelThemes)) {
    for (const fg of ['text-primary', 'text-secondary', 'text-muted', 'ink', 'muted', 'good', 'care', 'stay']) {
      for (const bg of ['surface-1', 'surface-2', 'ground']) {
        if (!t[fg] || !t[bg]) continue;
        const r = ratio(t[fg], t[bg]);
        ok(`panel ${name}: ${fg} on ${bg} is at least 4.5:1`, r >= 4.5, `${r.toFixed(2)}:1 (${t[fg]} on ${t[bg]})`);
      }
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
