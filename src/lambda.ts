/**
 * The Lambda entry point for the scheduled alert check in sweep.ts.
 *
 * The settings the server gets from sudor-secrets.sh come from the same Parameter Store
 * names here, read on a cold start: the data key that opens each record, the address
 * email is sent from, and whether texts are on. None of them is in the function's own
 * configuration, where anybody who can read the function could read them too.
 *
 * They have to be in place before anything else loads, because notify.ts reads the
 * sender address when it is first imported. So the check itself is imported after.
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { SweepResult } from './sweep.js';

const PREFIX = (process.env.SUDOR_PARAMS ?? '/sudor').replace(/\/$/, '');
const PARAMS: [env: string, name: string, required: boolean][] = [
  ['SUDOR_DATA_KEY', 'data-key', true],
  ['SUDOR_DATA_KEY_PREVIOUS', 'data-key-previous', false],
  ['SUDOR_EMAIL_FROM', 'email-from', false],
  ['SUDOR_SMS', 'sms', false],
];

async function loadSettings(): Promise<void> {
  // docker-compose.yml, where there is no Parameter Store and nothing is sealed.
  if (PREFIX === 'off') return;
  const ssm = new SSMClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  for (const [env, name, required] of PARAMS) {
    if (process.env[env]) continue;
    try {
      const r = await ssm.send(new GetParameterCommand({ Name: `${PREFIX}/${name}`, WithDecryption: true }));
      if (r.Parameter?.Value) process.env[env] = r.Parameter.Value;
    } catch (err) {
      // Absent is normal for the optional ones, and means the same as it does on the server.
      if (required || (err as { name?: string }).name !== 'ParameterNotFound') throw err;
    }
  }
}

let ready: Promise<typeof import('./sweep.js')> | null = null;

/** Throws on failure, so the invocation counts as failed and the alarm in infra/ sees it. */
export async function handler(): Promise<SweepResult> {
  ready ??= loadSettings().then(async () => {
    // A family told from here is counted on the table: this function's files do not outlive the run. See impact.ts.
    (await import('./impact.js')).countOnTable(true);
    return import('./sweep.js');
  });
  const { sweep } = await ready.catch((err) => {
    ready = null;
    throw err;
  });
  const result = await sweep();
  console.log(JSON.stringify({ sweep: result }));
  if (result.failed) throw new Error(`${result.failed} alert email${result.failed === 1 ? '' : 's'} failed to send`);
  return result;
}
