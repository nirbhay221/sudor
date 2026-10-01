/**
 * DNS rebinding, and the one exception that must not become a hole.
 *
 * The rule the 2025-11-25 spec asks for is simple to state and easy to get
 * subtly wrong in two opposite directions. Too strict and every real client
 * breaks, because the MCP SDK, curl and an Alexa+ host all send no Origin at
 * all. Too loose and a prefix match lets `http://localhost.attacker.com`
 * through, which is precisely the string an attacker would choose.
 *
 * Both directions are pinned here.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail}`); }
};

process.env.SUDOR_ALLOWED_ORIGINS = 'https://partner.example,https://other.example/';
process.env.SUDOR_PUBLIC_URL = 'https://sudor.example';
const { originAllowed, allowedOrigins } = await import('./dist/origin.js');

console.log('\nA request with no Origin is not a browser, and is allowed');
{
  check('undefined passes', originAllowed(undefined) === true);
  check('empty string passes', originAllowed('') === true);
}

console.log('\nLoopback is allowed on any port, for development');
{
  check('http://localhost:8788', originAllowed('http://localhost:8788') === true);
  check('http://127.0.0.1:3000', originAllowed('http://127.0.0.1:3000') === true);
  check('https://localhost', originAllowed('https://localhost') === true);
  check('http://[::1]:9000', originAllowed('http://[::1]:9000') === true);
}

console.log('\nThe rebinding strings that a prefix match would let through');
{
  check('localhost.attacker.com is refused', originAllowed('http://localhost.attacker.com') === false);
  check('127.0.0.1.attacker.com is refused', originAllowed('http://127.0.0.1.attacker.com') === false);
  check('a host merely containing localhost is refused', originAllowed('https://notlocalhost') === false);
  check('evil.example is refused', originAllowed('https://evil.example') === false);
  check('a lookalike of the public URL is refused', originAllowed('https://sudor.example.evil.com') === false);
}

console.log('\nThe server own origin and the configured list are allowed');
{
  check('the public URL passes', originAllowed('https://sudor.example') === true);
  check('with a trailing slash it still passes', originAllowed('https://sudor.example/') === true);
  check('a configured partner passes', originAllowed('https://partner.example') === true);
  check('a configured entry with a trailing slash was normalised', originAllowed('https://other.example') === true);
  check('the configured list is inspectable', allowedOrigins().length === 2, JSON.stringify(allowedOrigins()));
  check('http where the public URL is https is refused', originAllowed('http://sudor.example') === false);
}

console.log('\nEnd to end: the running server answers 403 before reading a body');
{
  mkdirSync('./data', { recursive: true });
  rmSync('./data/test-origin.json', { force: true });
  const port = 8846;
  const child = spawn(process.execPath, ['dist/server.js'], {
    env: { ...process.env, PORT: String(port), SUDOR_DATA: './data/test-origin.json' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const up = async () => {
    for (let i = 0; i < 60; i += 1) {
      try { await fetch(`${base}/health`); return true; } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    return false;
  };
  try {
    check('the server came up', await up());

    const bad = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', Origin: 'https://evil.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    check('a hostile Origin gets 403', bad.status === 403, String(bad.status));
    const body = await bad.json();
    check('the refusal names no detail an attacker could probe', body.error === 'forbidden', JSON.stringify(body));

    const none = await fetch(`${base}/health`);
    check('no Origin still works', none.status === 200, String(none.status));

    const local = await fetch(`${base}/health`, { headers: { Origin: 'http://localhost:5173' } });
    check('a loopback Origin still works', local.status === 200, String(local.status));

    const rebind = await fetch(`${base}/health`, { headers: { Origin: 'http://localhost.attacker.com' } });
    check('the rebinding lookalike gets 403 from the live server', rebind.status === 403, String(rebind.status));
  } finally {
    child.kill();
    rmSync('./data/test-origin.json', { force: true });
  }
}

console.log('\nThe origin secret: proving a request came through the gateway');
{
  // Re-imported with the secret set, because the module reads it at load time.
  process.env.SUDOR_ORIGIN_SECRET = 'a-shared-secret-value';
  const fresh = await import(`./dist/origin.js?secret=${Date.now()}`);
  check('it reports itself configured', fresh.originSecretConfigured() === true);
  check('the header name is lower case, as Node delivers it',
    fresh.ORIGIN_HEADER === fresh.ORIGIN_HEADER.toLowerCase(), fresh.ORIGIN_HEADER);

  const run = (headers, path = '/mcp') => {
    let status = 0, body = null, passed = false;
    fresh.requireOriginSecret(
      { headers, path },
      { status(c) { status = c; return this; }, json(b) { body = b; return this; } },
      () => { passed = true; },
    );
    return { status, body, passed };
  };

  check('no header is refused', run({}).status === 403);
  check('a wrong secret is refused', run({ [fresh.ORIGIN_HEADER]: 'nope' }).status === 403);
  check('a prefix of the secret is refused', run({ [fresh.ORIGIN_HEADER]: 'a-shared-secret' }).status === 403);
  check('a longer string starting with it is refused',
    run({ [fresh.ORIGIN_HEADER]: 'a-shared-secret-value-extra' }).status === 403);
  check('the right secret passes', run({ [fresh.ORIGIN_HEADER]: 'a-shared-secret-value' }).passed === true);

  // Every rejection has to look identical, or a prober learns which part was wrong.
  const a = run({});
  const b = run({ [fresh.ORIGIN_HEADER]: 'nope' });
  check('every refusal has the same body', JSON.stringify(a.body) === JSON.stringify(b.body),
    `${JSON.stringify(a.body)} vs ${JSON.stringify(b.body)}`);
  check('and it names nothing useful', JSON.stringify(a.body) === '{"error":"forbidden"}', JSON.stringify(a.body));

  // Liveness has to be answerable without a credential.
  check('/health is exempt', run({}, '/health').passed === true);

  delete process.env.SUDOR_ORIGIN_SECRET;
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
