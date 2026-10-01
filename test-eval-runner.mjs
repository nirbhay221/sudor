/**
 * The golden eval runner, tested end to end against a fake host.
 *
 * test-golden.mjs covers the scorer and the golden file. This covers the script
 * around them: that a perfect host passes, that each kind of fault is noticed and
 * turns into a non-zero exit, and that the report and baseline behave. No API key
 * and no network model call are involved.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
};

function run(mode, extra = [], out, env = {}) {
  return spawnSync(process.execPath, ['--import', './evals/fake-host.mjs', 'eval.mjs', '--trials', '3', ...extra], {
    encoding: 'utf8',
    env: { ...process.env, FAKE_HOST: mode, SUDOR_EVAL_OUT: out, ...env },
    timeout: 120000,
  });
}

const out = mkdtempSync(join(tmpdir(), 'sudor-runner-'));

console.log('\nA perfect host');
const p = run('perfect', ['--save-baseline'], out);
ok('exits 0', p.status === 0, p.stdout.slice(-400) + p.stderr.slice(-400));
ok('prints PASS', /\nPASS\n/.test(p.stdout));
ok('reports pass^3 of 100%', /pass\^3\s+: 100\.0%/.test(p.stdout));
ok('the chosen read-only tools really were called and answered', /execution\s+: (\d+)\/\1 /.test(p.stdout) && !/execution\s+: 0\/0/.test(p.stdout), p.stdout.match(/execution.*/)?.[0]);
ok('last-run.json was written', existsSync(join(out, 'last-run.json')));
ok('baseline.json was written on request', existsSync(join(out, 'baseline.json')));
const rep = JSON.parse(readFileSync(join(out, 'last-run.json'), 'utf8'));
ok('the report carries every case', rep.perCase.length === rep.cases && rep.cases > 50);
ok('the report carries per-kind numbers', Boolean(rep.byKind.asr && rep.byKind.adversarial));

console.log('\nA perfect host again, against its own baseline');
const p2 = run('perfect', [], out);
ok('exits 0 and reports no regressions', p2.status === 0 && /0 regressed/.test(p2.stdout), p2.stdout.slice(-300));

console.log('\nA flaky host');
const f = run('flaky', [], out);
ok('exits 1', f.status === 1, String(f.status));
ok('names the flaky sentence as regressed from the baseline', /REGRESSED/.test(f.stdout));
ok('counts a flaky case, not a never-right one', /1 flaky/.test(f.stdout));

console.log('\nA host that invents tools when it should decline');
const i = run('inventor', [], mkdtempSync(join(tmpdir(), 'sudor-runner-')));
ok('exits 1', i.status === 1);
ok('fails on declining specifically', /declining .* is under/.test(i.stdout), i.stdout.slice(-400));

console.log('\nA host that chooses right and then passes arguments the tool rejects');
const br = run('broken', [], mkdtempSync(join(tmpdir(), 'sudor-runner-')));
ok('exits 1', br.status === 1);
ok('fails on the argument score', /arguments .* is under/.test(br.stdout), br.stdout.slice(-400));

console.log('\nThe budget');
const bu = run('perfect', ['--budget', '0.003'], mkdtempSync(join(tmpdir(), 'orbita-runner-')));
ok('a run that reaches its budget stops with exit 2 and says so', bu.status === 2 && /Stopped at the budget/.test(bu.stderr), bu.stderr.slice(-300));
ok('and scores nothing, so a partial run is never reported as a result', !/tool selection/.test(bu.stdout));
ok('a normal run reports what it cost', /cost\s+: about \$\d+\.\d\d for \d+ calls/.test(p.stdout), p.stdout.match(/cost.*/)?.[0]);

console.log('\nNo key');
const nk = spawnSync(process.execPath, ['eval.mjs'], { encoding: 'utf8', env: { ...process.env, SUDOR_ANTHROPIC_KEY: '', ANTHROPIC_API_KEY: '' } });
ok('exits 2 and says why', nk.status === 2 && /not set/.test(nk.stderr));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
