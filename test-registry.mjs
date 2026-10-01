/**
 * server.json against the MCP Registry's own schema, and the friction log against the hackathon's format.
 *
 * Two files that are only ever read by somebody else, and so only ever found wrong by somebody else:
 *
 * server.json is what `mcp-publisher publish` sends to the registry. The registry validates it against a
 * published JSON Schema (vendored here as evals/server.schema.json, from
 * static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json) and refuses a file that does not
 * conform. Found by running this the first time: the description was over the schema's 100 character limit.
 *
 * FRICTION.md earns up to a 10% judging bonus, and the rules say what each entry must document: the task,
 * the steps, expected against actual, a severity, a workaround and a suggestion. Entries that read well but
 * leave one out are the cheapest way to lose part of that.
 */
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
};

const schema = JSON.parse(readFileSync('evals/server.schema.json', 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const doc = JSON.parse(readFileSync('server.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

console.log('\nserver.json');
const valid = validate(doc);
ok('conforms to the registry schema', valid, JSON.stringify((validate.errors ?? []).slice(0, 3)));
ok('the version matches package.json', doc.version === pkg.version, `${doc.version} vs ${pkg.version}`);
ok('the name is in the io.github.<user>/<name> form', /^io\.github\.[a-z0-9-]+\/[a-z0-9-]+$/i.test(doc.name), doc.name);
ok('there is a streamable-http remote over https', doc.remotes?.some((r) => r.type === 'streamable-http' && r.url.startsWith('https://')));
ok('the remote ends in /mcp', doc.remotes?.every((r) => r.url.endsWith('/mcp')));
ok('control: a description over 100 characters is rejected', !validate({ ...doc, description: 'x'.repeat(101) }));
ok('control: a missing name is rejected', !validate({ ...doc, name: undefined }));

console.log('\nFRICTION.md');
const text = readFileSync('FRICTION.md', 'utf8');
const entries = text.split(/\n(?=## \d+\. )/).slice(1);
ok('there are friction entries', entries.length >= 5, String(entries.length));
const FIELDS = [
  ['task', /\*\*Task\.?\*\*/], ['steps', /\*\*Steps\.?\*\*/], ['expected', /\*\*Expected\.?\*\*/], ['actual', /\*\*Actual\.?\*\*/],
  ['severity', /\*\*Severity/], ['workaround', /\*\*Workaround\.?\*\*/], ['suggestion', /\*\*Suggestion\.?\*\*/],
];
for (const e of entries) {
  const title = e.split('\n')[0].slice(0, 60);
  const missing = FIELDS.filter(([, re]) => !re.test(e)).map(([n]) => n);
  ok(`${title} documents every required element`, missing.length === 0, `missing: ${missing.join(', ')}`);
}
const bare = '## 1. t\n\n**Severity: low.**\n\nSome prose only.\n';
ok('control: an entry that is only prose is reported', FIELDS.some(([, re]) => !re.test(bare)));
ok('no em dashes', !text.includes('—'));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
