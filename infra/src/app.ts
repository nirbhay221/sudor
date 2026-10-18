/**
 * cdk deploy -c publicUrl=https://... [-c serverRole=...] [-c alarmEmail=...] [-c emailFrom=...]
 *
 * The values come in at deploy time and are not kept in this repository. See stack.ts.
 */
import { App } from 'aws-cdk-lib';
import { SudorStack } from './stack.js';

const app = new App();
const ctx = (k: string): string | undefined => {
  const v = app.node.tryGetContext(k);
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
};
const publicUrl = ctx('publicUrl');
if (!publicUrl) throw new Error('Pass the server address: cdk deploy -c publicUrl=https://... (it goes in the stop link of every email).');

new SudorStack(app, 'SudorStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
  publicUrl,
  serverRole: ctx('serverRole'),
  alarmEmail: ctx('alarmEmail'),
  emailFrom: ctx('emailFrom'),
});
