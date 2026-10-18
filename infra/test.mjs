/**
 * What the stack promises, checked on the synthesized template. No AWS account and no
 * Docker build: the image asset is only staged, never built, at synth time.
 */
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SudorStack } from './dist/stack.js';

let pass = 0, fail = 0;
const check = (label, fn) => {
  try { fn(); pass++; console.log(`  ok    ${label}`); }
  catch (err) { fail++; console.log(`  FAIL  ${label}  ${String(err.message).split('\n')[0]}`); }
};

const app = new App();
const stack = new SudorStack(app, 'Test', { env: { account: '111111111111', region: 'us-east-1' }, publicUrl: 'https://sudor.example.org', serverRole: 'server-role', alarmEmail: 'ops@example.org', emailFrom: 'alerts@example.org' });
const t = Template.fromStack(stack);

console.log('\nThe people table');
check('one item per person, keyed by id, on demand', () => t.hasResourceProperties('AWS::DynamoDB::Table', { KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }], BillingMode: 'PAY_PER_REQUEST' }));
check('point-in-time recovery and deletion protection are on', () => t.hasResourceProperties('AWS::DynamoDB::Table', { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true }, DeletionProtectionEnabled: true }));
check('DynamoDB deletes sandbox records itself, from the ttl attribute', () => t.hasResourceProperties('AWS::DynamoDB::Table', { TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true } }));
check('deleting the stack keeps the table', () => t.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' }));

console.log('\nThe alert check');
check('runs as an image from the repository Dockerfile', () => t.hasResourceProperties('AWS::Lambda::Function', { PackageType: 'Image' }));
check('one at a time: it times out well before the next run, and is never retried, so two runs never email the same family', () => { t.hasResourceProperties('AWS::Lambda::Function', { Timeout: 300 }); t.hasResourceProperties('AWS::Scheduler::Schedule', { Target: Match.objectLike({ RetryPolicy: { MaximumRetryAttempts: 0 } }) }); });
check('uses the table, requires encryption, and has the stop link address', () => t.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ SUDOR_STORE: 'dynamodb', SUDOR_REQUIRE_ENCRYPTION: 'on', SUDOR_PUBLIC_URL: 'https://sudor.example.org' }) } }));
check('no key or address is in its configuration', () => {
  const fn = Object.values(t.findResources('AWS::Lambda::Function'))[0];
  const vars = fn.Properties.Environment.Variables;
  if (vars.SUDOR_DATA_KEY || vars.SUDOR_EMAIL_FROM) throw new Error('a secret is in the environment');
});
check('reads only its own four parameters', () => {
  const doc = JSON.stringify(t.findResources('AWS::IAM::Policy'));
  for (const n of ['data-key', 'data-key-previous', 'email-from', 'sms']) if (!doc.includes(`parameter/sudor/${n}`)) throw new Error(`missing ${n}`);
  if (/parameter\/sudor\/\*/.test(doc)) throw new Error('a wildcard parameter');
});
check('sends email only as the named sender', () => {
  const doc = JSON.stringify(t.findResources('AWS::IAM::Policy'));
  if (!doc.includes('identity/alerts@example.org')) throw new Error('not scoped');
});

console.log('\nEvery ten minutes, and watched');
check('EventBridge Scheduler starts it every ten minutes, with no retries to pile up', () => t.hasResourceProperties('AWS::Scheduler::Schedule', { ScheduleExpression: 'rate(10 minutes)', Target: Match.objectLike({ RetryPolicy: { MaximumRetryAttempts: 0 } }) }));
check('an alarm when it fails twice in a row', () => t.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'Errors', EvaluationPeriods: 2 }));
check('and an alarm when it has stopped running at all', () => t.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'Invocations', ComparisonOperator: 'LessThanThreshold', TreatMissingData: 'breaching' }));
check('both go to the alarm email', () => t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.org' }));
check('the existing server role is given the table', () => {
  const policies = Object.values(t.findResources('AWS::IAM::Policy'));
  if (!policies.some((p) => JSON.stringify(p.Properties.Roles ?? []).includes('server-role'))) throw new Error('no policy on server-role');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
