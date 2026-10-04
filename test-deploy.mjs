// Every tool, including the ones outside the default scope, so they stay tested. See src/brief.ts.
process.env.SUDOR_SCOPE ??= 'all';
/**
 * The deploy scripts, tested without AWS and without a server.
 *
 * Nothing in the rest of the suite touches deploy/, and deploy/ is where a mistake becomes an outage: a
 * secret handed to the service too early answers every public request with a 403, a missing key that does
 * not stop the service stores a farm's records in the clear, and a secret printed to a log is a leak.
 * So the secrets fetcher is run for real, in bash, against a fake `aws` that answers from a table, and the
 * unit definition is read for the settings the README promises.
 *
 * Needs bash. Where there is none, the script-running half is reported as skipped rather than passed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SVC = 'sudor';
const KEY = 'SUDOR';
const UNIT = 'deploy/sudor.service';
const FETCHER = `deploy/${SVC}-secrets.sh`;

let passed = 0, failed = 0, skipped = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
};

const BASH = ['C:/Program Files/Git/bin/bash.exe', '/usr/bin/bash', '/bin/bash'].find((p) => existsSync(p)) ?? 'bash';
const posix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
const haveBash = spawnSync(BASH, ['-c', 'echo yes'], { encoding: 'utf8' }).stdout?.trim() === 'yes';

const scratch = mkdtempSync(join(tmpdir(), `${SVC}-deploy-`));
const fakebin = join(scratch, 'bin');
spawnSync(BASH, ['-c', `mkdir -p "${posix(fakebin)}"`]);
// A stand-in for the AWS CLI: answers `ssm get-parameter --name X` from PARAM_<X with / and - as _>, and fails
// the way the real one does when the parameter is not there.
writeFileSync(join(fakebin, 'aws'), `#!/usr/bin/env bash
name=""
while [ $# -gt 0 ]; do case "$1" in --name) name="$2"; shift 2;; *) shift;; esac; done
var="PARAM_$(echo "$name" | tr '/-' '__')"
if [ "\${AWS_FAILS:-}" = "1" ]; then echo "An error occurred (AccessDeniedException)" >&2; exit 254; fi
if [ -z "\${!var+x}" ]; then echo "An error occurred (ParameterNotFound)" >&2; exit 254; fi
printf '%s\\n' "\${!var}"
`, { mode: 0o755 });
chmodSync(join(fakebin, 'aws'), 0o755);
// Windows' file system cannot honour the modes `install` sets on a directory, and says so by failing. On
// Windows only, a stand-in that just makes the directory lets the rest of the script be tested; on Linux the
// real `install` runs.
if (process.platform === 'win32') {
  writeFileSync(join(fakebin, 'install'), ['#!/usr/bin/env bash', 'for last; do :; done', 'mkdir -p "$last"', ''].join('\n'), { mode: 0o755 });
}

function run(params, extraEnv = {}) {
  // A directory that does not exist yet, which is the real situation: the script creates /run/<service>.
  const dir = join(mkdtempSync(join(scratch, 'run-')), 'secrets');
  const env = {
    ...process.env,
    [`${KEY}_SECRETS_DIR`]: posix(dir),
    [`${KEY}_SECRETS_OWNER`]: 'none',
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [`PARAM_${k.replace(/[/-]/g, '_')}`, v])),
    ...extraEnv,
  };
  const r = spawnSync(BASH, ['-c', `PATH="${posix(fakebin)}:$PATH" bash "${posix(process.cwd())}/${FETCHER}"`], { encoding: 'utf8', env });
  const file = join(dir, 'env');
  return { ...r, text: existsSync(file) ? readFileSync(file, 'utf8') : null, file };
}

const DATA = 'A'.repeat(43) + '=';
const PREV = 'B'.repeat(43) + '=,' + 'C'.repeat(43) + '=';
const ORIGIN = 'originsecret-' + 'x'.repeat(30);

console.log('\nThe scripts are well formed');
for (const f of ['deploy/bundle.sh', FETCHER, ...(existsSync('deploy/deploy.sh') ? ['deploy/deploy.sh'] : []), ...(existsSync('deploy/user-data.sh') ? ['deploy/user-data.sh'] : [])]) {
  if (!haveBash) { skipped++; console.log(`  skip  ${f} (no bash on this machine)`); continue; }
  const r = spawnSync(BASH, ['-n', posix(join(process.cwd(), f))], { encoding: 'utf8' });
  ok(`${f} parses`, r.status === 0, r.stderr);
}
ok('the scripts are saved with unix line endings', ![FETCHER, 'deploy/bundle.sh'].some((f) => readFileSync(f, 'utf8').includes('\r')));

if (haveBash) {
  console.log('\nThe secrets fetcher, run against a fake aws');
  const armed = run({ [`/${SVC}/data-key`]: DATA, [`/${SVC}/data-key-previous`]: PREV, [`/${SVC}/origin-secret`]: ORIGIN, [`/${SVC}/origin-enforce`]: 'on' });
  ok('exits 0', armed.status === 0, armed.stderr);
  ok('writes the data key', armed.text?.includes(`${KEY}_DATA_KEY=${DATA}\n`), armed.text);
  ok('writes the keys being rotated out', armed.text?.includes(`${KEY}_DATA_KEY_PREVIOUS=${PREV}\n`));
  ok('hands over the origin secret when it is armed', armed.text?.includes(`${KEY}_ORIGIN_SECRET=${ORIGIN}\n`));
  ok('prints no secret to the log', ![DATA, ORIGIN, PREV].some((s) => (armed.stdout + armed.stderr).includes(s)), armed.stdout + armed.stderr);
  if (process.platform !== 'win32') {
    ok('the file is readable by its owner only', (statSync(armed.file).mode & 0o777) === 0o400, (statSync(armed.file).mode & 0o777).toString(8));
  } else { skipped++; console.log('  skip  file mode (Windows does not report unix modes)'); }

  const second = run({ [`/${SVC}/data-key`]: DATA, [`/${SVC}/origin-secret`]: ORIGIN, [`/${SVC}/origin-enforce`]: 'on' });
  ok('running it again works', second.status === 0 && second.text?.includes('DATA_KEY='), second.stderr);

  console.log('\nThe origin secret is handed over only when armed');
  const exists = { [`/${SVC}/data-key`]: DATA, [`/${SVC}/origin-secret`]: ORIGIN };
  const unarmed = run(exists);
  ok('with no enforce parameter the secret is left out', unarmed.status === 0 && !unarmed.text.includes('ORIGIN_SECRET'), unarmed.text);
  const off = run({ ...exists, [`/${SVC}/origin-enforce`]: 'off' });
  ok('with enforce set to off the secret is left out', !off.text.includes('ORIGIN_SECRET'), off.text);
  const odd = run({ ...exists, [`/${SVC}/origin-enforce`]: 'ON' });
  ok('only the exact word on arms it', !odd.text.includes('ORIGIN_SECRET'), odd.text);
  const noSecret = run({ [`/${SVC}/data-key`]: DATA, [`/${SVC}/origin-enforce`]: 'on' });
  ok('armed but with no secret stored, nothing is written and nothing breaks', noSecret.status === 0 && !noSecret.text.includes('ORIGIN_SECRET'), noSecret.stderr);

  console.log('\nA missing key is left for the service to refuse');
  const noKey = run({});
  ok('with no parameters at all the fetcher still exits 0', noKey.status === 0, noKey.stderr);
  ok('and writes no key, so ' + `${KEY}_REQUIRE_ENCRYPTION=on` + ' stops the service rather than the fetcher', noKey.text === '', JSON.stringify(noKey.text));
  const denied = run({ [`/${SVC}/data-key`]: DATA }, { AWS_FAILS: '1' });
  ok('an AWS error exits 0 and leaks nothing', denied.status === 0 && denied.text === '', denied.stderr);
}

console.log('\nThe unit definition says what the README promises');
const unit = readFileSync(UNIT, 'utf8');
ok('it runs the fetcher before the service, with the + so it can write /run', new RegExp(`ExecStartPre=\\+/usr/local/libexec/${SVC}-secrets`).test(unit));
ok('it reads the fetched file', /EnvironmentFile=-\/run\/\w+\/env/.test(unit));
ok('it refuses to start without a data key', new RegExp(`${KEY}_REQUIRE_ENCRYPTION=on`).test(unit));
ok('it turns authentication on', new RegExp(`${KEY}_AUTH=on`).test(unit));
ok('it keeps tokens on disk across a deploy', new RegExp(`${KEY}_AUTH_DATA=/var/lib/${SVC}/auth.json`).test(unit));
ok('it trusts exactly one proxy hop', new RegExp(`${KEY}_TRUST_PROXY=1\\b`).test(unit));
ok('it never trusts the forwarded header blindly', !new RegExp(`${KEY}_TRUST_PROXY=(true|2|3)`).test(unit));
ok('no secret value is written in the unit', !/(KEY|SECRET)=[A-Za-z0-9+/=]{20,}/.test(unit));

console.log('\nThe bundle carries what the host installs from it');
const bundle = readFileSync('deploy/bundle.sh', 'utf8');
ok('it includes the fetcher', bundle.includes(`${SVC}-secrets.sh`));
ok('it includes the unit definition', bundle.includes(UNIT.replace('deploy/', 'deploy/')));
ok('it includes the lock file, so the host installs the locked versions', bundle.includes('package-lock.json'));
ok('it does not ship tests, data or secrets', !/\b(data|\.env|test)/.test(bundle.split('tar -czf')[1]?.split('\n')[0] ?? ''));

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
process.exit(failed ? 1 : 0);
