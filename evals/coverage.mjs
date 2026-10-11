// How many of the most-prescribed medicines in the United States does Sudor know something about?
//
//   node evals/coverage.mjs
//
// The list is ClinCalc DrugStats Top 300 for 2024 (from AHRQ's MEPS survey), split to single ingredients.
// Each name goes the way a spoken name goes: the curated list first, then the National Library of
// Medicine's RxClass, live. Free, no key. It prints what is known, by which route, and what is not.
import { readFileSync } from 'node:fs';
const meds = await import('../dist/meds.js');
const rx = await import('../dist/rxclass.js');
const names = readFileSync(new URL('./top300-2024.txt', import.meta.url), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const out = { curated: [], byClass: [], unknown: [], failed: [] };
for (const name of names) {
  const hit = meds.findMedication(name);
  if (hit) { out.curated.push(name); continue; }
  try {
    const c = await rx.classify(name);
    if (c) out.byClass.push(`${name} (${c.drugClass})`); else out.unknown.push(name);
  } catch { out.failed.push(name); }
  await new Promise((r) => setTimeout(r, 60));
}
const n = names.length;
console.log(`${n} ingredients checked`);
console.log(`known from the curated list: ${out.curated.length}`);
console.log(`known from RxClass, live:    ${out.byClass.length}`);
console.log(`not known for heat or cold:  ${out.unknown.length}`);
if (out.failed.length) console.log(`lookup failed:               ${out.failed.length}`);
console.log('\nBY CLASS\n' + out.byClass.join(', '));
console.log('\nNOT KNOWN\n' + out.unknown.join(', '));
if (out.failed.length) console.log('\nFAILED\n' + out.failed.join(', '));
