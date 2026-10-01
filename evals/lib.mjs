/**
 * The parts of the golden eval that need no model, so they can be tested for free.
 *
 * eval.mjs asks a model which tool a sentence means. Everything around that
 * question lives here: checking that the golden file is itself sound, scoring
 * repeated trials, and comparing a run with the last one kept. The runner is thin
 * and this is what `npm test` exercises, because a scorer that is wrong gives a
 * confident number about nothing.
 *
 * Why repeated trials. A model's choice is a sample, not a constant. One pass over
 * 44 sentences says "it got this right once", and a description that works two
 * times in three looks identical to one that works every time. The tau-bench work
 * reports pass^k for this reason: the chance that ALL k trials of a case succeed,
 * which is what a voice product needs, because a customer does not get to retry
 * the sentence the model was unlucky on. Pass^k = C(c,k)/C(n,k) for c successes in
 * n trials.
 */

/** Does the model's answer for one trial count as right for this case. */
export function judgeTrial(c, chosen) {
  const wantedNone = c.tool === null;
  // alsoOk lists other tools that are a defensible answer to an ambiguous sentence. The sentence still has
  // to be one a person would say; this is for two readings that are both right, not for loosening a miss.
  const toolOk = wantedNone ? chosen.tool === null : chosen.tool === c.tool || (c.alsoOk ?? []).includes(chosen.tool);
  let argWrong = [];
  if (toolOk && c.args && chosen.tool === c.tool) {
    argWrong = Object.entries(c.args).filter(([k, v]) => !sameValue(chosen.args?.[k], v));
  }
  return { toolOk, argsChecked: Boolean(toolOk && c.args), argWrong };
}

function sameValue(got, want) {
  if (typeof got === 'string' && typeof want === 'string') {
    return got.trim().toLowerCase() === want.trim().toLowerCase();
  }
  return got === want;
}

/** C(n,k) without overflow for the small numbers used here. */
function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
  return r;
}

/** Probability that k trials drawn from n (c of them good) are all good. */
export function passHatK(n, c, k) {
  if (n <= 0 || k > n) return 0;
  return choose(c, k) / choose(n, k);
}

/**
 * Fold per-trial results into per-case and overall numbers.
 *
 * `results` is one entry per case: { case, trials: [{ toolOk, argsChecked,
 * argWrong, exec?, tool, ms }] }. A case counts as stable only if every trial got
 * the tool right AND the arguments it was asked about, which is the strict reading
 * and the one that matches what a customer experiences.
 */
export function summarise(results, k) {
  const perCase = results.map((r) => {
    const n = r.trials.length;
    const good = r.trials.filter((t) => t.toolOk && t.argWrong.length === 0).length;
    const toolGood = r.trials.filter((t) => t.toolOk).length;
    return {
      say: r.case.say,
      want: r.case.tool,
      kind: kindOf(r.case),
      n,
      good,
      toolGood,
      passHatK: passHatK(n, good, Math.min(k, n)),
      stable: n > 0 && good === n,
      flaky: good > 0 && good < n,
      neverRight: n > 0 && good === 0,
      got: [...new Set(r.trials.map((t) => String(t.tool)))],
    };
  });

  const byKind = {};
  for (const p of perCase) {
    const b = (byKind[p.kind] ??= { cases: 0, trials: 0, toolGood: 0 });
    b.cases += 1;
    b.trials += p.n;
    b.toolGood += p.toolGood;
  }
  for (const b of Object.values(byKind)) b.toolAccuracy = b.trials ? b.toolGood / b.trials : 0;

  const trials = results.flatMap((r) => r.trials);
  const argTrials = trials.filter((t) => t.argsChecked);
  const execTrials = trials.filter((t) => t.exec);
  const total = trials.length;

  return {
    cases: results.length,
    trialsPerCase: k,
    toolAccuracy: total ? trials.filter((t) => t.toolOk).length / total : 0,
    argAccuracy: argTrials.length ? argTrials.filter((t) => t.argWrong.length === 0).length / argTrials.length : 1,
    passHatK: perCase.length ? perCase.reduce((s, p) => s + p.passHatK, 0) / perCase.length : 0,
    stableCases: perCase.filter((p) => p.stable).length,
    flakyCases: perCase.filter((p) => p.flaky).length,
    neverRightCases: perCase.filter((p) => p.neverRight).length,
    byKind,
    execution: {
      ran: execTrials.length,
      failed: execTrials.filter((t) => !t.exec.ok).length,
    },
    perCase,
  };
}

export function kindOf(c) {
  if (c.kind) return c.kind;
  return c.tool === null ? 'decline' : 'route';
}

/**
 * Things in the golden file that would make a score meaningless.
 *
 * `tools` is the real tools/list. The point is that the file cannot drift from the
 * server: a case naming a tool that was renamed, an argument the schema no longer
 * has, or an enum value nobody can pass would otherwise show up as a model
 * failure, and somebody would spend an afternoon "fixing" a description that was
 * fine.
 */
export function validateGolden(golden, tools) {
  const problems = [];
  const warnings = [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const cases = golden.cases.filter((c) => typeof c.say === 'string');

  const seen = new Map();
  for (const [i, c] of cases.entries()) {
    const at = `case ${i + 1} "${c.say}"`;
    if (!c.say.trim()) problems.push(`${at}: empty utterance`);
    const key = c.say.trim().toLowerCase();
    if (seen.has(key)) problems.push(`${at}: duplicates case ${seen.get(key)}`);
    seen.set(key, i + 1);

    if (!('tool' in c)) {
      problems.push(`${at}: no "tool" key (use null for a case that should decline)`);
      continue;
    }
    for (const alt of c.alsoOk ?? []) {
      if (!byName.has(alt)) problems.push(`${at}: alsoOk names "${alt}", which is not published`);
      if (alt === c.tool) problems.push(`${at}: alsoOk repeats the main tool`);
    }
    if (c.tool === null) {
      if (c.args) problems.push(`${at}: a declining case cannot name arguments`);
      continue;
    }
    const tool = byName.get(c.tool);
    if (!tool) {
      problems.push(`${at}: tool "${c.tool}" is not published by the server`);
      continue;
    }
    const props = tool.inputSchema?.properties ?? {};
    for (const [k, v] of Object.entries(c.args ?? {})) {
      const p = props[k];
      if (!p) {
        problems.push(`${at}: ${c.tool} has no parameter "${k}"`);
        continue;
      }
      if (p.enum && !p.enum.map((x) => String(x).toLowerCase()).includes(String(v).toLowerCase())) {
        problems.push(`${at}: "${v}" is not one of ${c.tool}.${k} ${JSON.stringify(p.enum)}`);
      }
      const t = p.type;
      if (t === 'number' || t === 'integer') {
        if (typeof v !== 'number') problems.push(`${at}: ${k} should be a number`);
      } else if (t === 'boolean') {
        if (typeof v !== 'boolean') problems.push(`${at}: ${k} should be true or false`);
      } else if (t === 'string' && typeof v !== 'string') {
        problems.push(`${at}: ${k} should be a string`);
      }
    }
  }

  // A tool with no case is a tool whose description nobody is checking.
  const covered = new Set(cases.map((c) => c.tool).filter(Boolean));
  const exempt = new Set(golden.notCovered ?? []);
  for (const t of tools) {
    if (!covered.has(t.name) && !exempt.has(t.name)) {
      problems.push(`tool "${t.name}" has no golden case (add one, or list it in "notCovered" with a reason)`);
    }
  }
  for (const name of exempt) if (!byName.has(name)) problems.push(`"notCovered" names "${name}", which is not a tool`);

  // Declining has to be a real share of the set, or the eval rewards a host that
  // always reaches for something.
  const declines = cases.filter((c) => c.tool === null);
  if (declines.length / Math.max(1, cases.length) < 0.12) {
    problems.push(`only ${declines.length} of ${cases.length} cases expect no tool; at least 12% should`);
  }
  if (!declines.some((c) => c.kind === 'adversarial')) problems.push('no adversarial case (prompt injection, or a request the data cannot support)');

  // Two tools whose descriptions share most of their words are the likeliest place
  // for a host to pick the wrong one. Only a warning: similar is not the same as
  // ambiguous, and the model run is what settles it.
  const words = (s) => new Set((s ?? '').toLowerCase().match(/[a-z]{4,}/g) ?? []);
  for (let i = 0; i < tools.length; i += 1) {
    for (let j = i + 1; j < tools.length; j += 1) {
      const a = words(tools[i].description);
      const b = words(tools[j].description);
      const inter = [...a].filter((w) => b.has(w)).length;
      const jac = inter / Math.max(1, a.size + b.size - inter);
      if (jac > 0.45) warnings.push(`${tools[i].name} and ${tools[j].name} have ${(jac * 100).toFixed(0)}% of their description words in common`);
    }
  }

  return { problems, warnings, cases: cases.length, declines: declines.length };
}

/**
 * What changed since the run that was kept as the baseline.
 *
 * A case that was stable then and is not now is a regression, and it is reported
 * by sentence because that is what somebody will go and read. The overall drop is
 * reported too, but the per-case list is the useful one: a score that holds at 93%
 * while the cases underneath it are swapped is not holding.
 */
export function compare(now, before) {
  if (!before) return { regressions: [], fixed: [], drop: 0, hadBaseline: false };
  const was = new Map(before.perCase.map((p) => [p.say, p]));
  const regressions = [];
  const fixed = [];
  for (const p of now.perCase) {
    const old = was.get(p.say);
    if (!old) continue;
    if (old.stable && !p.stable) regressions.push({ say: p.say, was: `${old.good}/${old.n}`, now: `${p.good}/${p.n}`, got: p.got });
    if (!old.stable && p.stable) fixed.push({ say: p.say });
  }
  return { regressions, fixed, drop: before.toolAccuracy - now.toolAccuracy, hadBaseline: true };
}
