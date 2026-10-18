/**
 * The people table in DynamoDB, when the store is told to use one.
 *
 * The file in store.ts is one process on one machine: a second copy of the server
 * cannot share it, and the scheduled alert check in sweep.ts runs somewhere else
 * entirely. So with SUDOR_STORE=dynamodb every person is one item, keyed by their id.
 *
 *   id     the person's id, as the store uses it
 *   body   the record as JSON, sealed with the data key when one is set (vault.ts)
 *   v      a version number, raised by one on every write
 *   ttl    for sandbox records only: when DynamoDB itself may delete it (seconds)
 *
 * Every write says which version it read. If somebody else wrote in between, the
 * write is refused rather than quietly replacing theirs, and store.ts starts again
 * from what is there now. That is the whole of the concurrency story, and it is
 * enough for two writers that touch the same person rarely.
 *
 * Nothing here knows what a person is. It moves strings.
 */

import {
  DynamoDBClient,
  ScanCommand,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  UpdateItemCommand,
  BatchGetItemCommand,
  type BatchGetItemCommandOutput,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';

export type Item = { id: string; body: string; v: number };

/** The few calls the store makes, so a test can stand in for DynamoDB. */
export type Backend = {
  scan(): Promise<Item[]>;
  get(id: string): Promise<Item | null>;
  /** False when the version on the table is not the one expected. */
  put(item: Item, expected: number, ttl: number | null): Promise<boolean>;
  remove(id: string): Promise<void>;
  /** One more on a counter item. It has no body, so scan() never returns it as a person. See impact.ts. */
  add(id: string, field: string, ttl: number): Promise<void>;
  /** The counters on those items, missing ones left out. */
  counters(ids: string[]): Promise<Record<string, Record<string, number>>>;
};

export const tableName = (): string => process.env.SUDOR_TABLE ?? 'sudor-people';
export const tableOn = (): boolean => (process.env.SUDOR_STORE ?? 'file').toLowerCase() === 'dynamodb';

const toItem = (r: Record<string, AttributeValue> | undefined): Item | null =>
  r?.id?.S != null && r.body?.S != null ? { id: r.id.S, body: r.body.S, v: Number(r.v?.N ?? 0) } : null;

function dynamo(): Backend {
  // An endpoint for DynamoDB Local in docker-compose.yml. Unset on AWS.
  const client = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1', ...(process.env.SUDOR_DYNAMO_ENDPOINT ? { endpoint: process.env.SUDOR_DYNAMO_ENDPOINT } : {}) });
  const TableName = tableName();
  return {
    async scan() {
      const out: Item[] = [];
      let start: Record<string, AttributeValue> | undefined;
      do {
        // Consistent, because this is the read a restart is built from.
        const page = await client.send(new ScanCommand({ TableName, ConsistentRead: true, ExclusiveStartKey: start }));
        for (const r of page.Items ?? []) {
          const item = toItem(r);
          if (item) out.push(item);
        }
        start = page.LastEvaluatedKey;
      } while (start);
      return out;
    },
    async get(id) {
      const r = await client.send(new GetItemCommand({ TableName, Key: { id: { S: id } }, ConsistentRead: true }));
      return toItem(r.Item);
    },
    async put(item, expected, ttl) {
      try {
        await client.send(
          new PutItemCommand({
            TableName,
            Item: { id: { S: item.id }, body: { S: item.body }, v: { N: String(item.v) }, ...(ttl != null ? { ttl: { N: String(ttl) } } : {}) },
            ConditionExpression: expected === 0 ? 'attribute_not_exists(id)' : 'v = :v',
            ...(expected === 0 ? {} : { ExpressionAttributeValues: { ':v': { N: String(expected) } } }),
          }),
        );
        return true;
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },
    async remove(id) {
      await client.send(new DeleteItemCommand({ TableName, Key: { id: { S: id } } }));
    },
    async add(id, field, ttl) {
      await client.send(
        new UpdateItemCommand({
          TableName,
          Key: { id: { S: id } },
          UpdateExpression: 'ADD #f :one SET #t = :ttl',
          ExpressionAttributeNames: { '#f': field, '#t': 'ttl' },
          ExpressionAttributeValues: { ':one': { N: '1' }, ':ttl': { N: String(ttl) } },
        }),
      );
    },
    async counters(ids) {
      const out: Record<string, Record<string, number>> = {};
      for (let i = 0; i < ids.length; i += 100) {
        let keys: Record<string, AttributeValue>[] | undefined = ids.slice(i, i + 100).map((id) => ({ id: { S: id } }));
        // What DynamoDB could not read in one go comes back as unprocessed, and is asked for again.
        for (let tries = 0; keys?.length && tries < 5; tries++) {
          const r: BatchGetItemCommandOutput = await client.send(new BatchGetItemCommand({ RequestItems: { [TableName]: { Keys: keys } } }));
          for (const row of r.Responses?.[TableName] ?? []) {
            const counts: Record<string, number> = {};
            for (const [k, v] of Object.entries(row)) if (k !== 'id' && k !== 'ttl' && v.N != null) counts[k] = Number(v.N);
            if (row.id?.S) out[row.id.S] = counts;
          }
          keys = r.UnprocessedKeys?.[TableName]?.Keys;
        }
      }
      return out;
    },
  };
}

let backend: Backend | null = null;
export const table = (): Backend => (backend ??= dynamo());

/** For tests: an in-memory table with the same version rule. Null puts DynamoDB back. */
export function configureForTest(b: Backend | null): void {
  backend = b;
}

/** The same rules as the real table, in a Map. Exported so the tests and the sweep test share one. */
export function memoryTable(): Backend & { rows: Map<string, Item & { ttl: number | null }>; counts: Map<string, Record<string, number>> } {
  const rows = new Map<string, Item & { ttl: number | null }>();
  const counts = new Map<string, Record<string, number>>();
  return {
    rows,
    counts,
    async scan() {
      return [...rows.values()].map(({ id, body, v }) => ({ id, body, v }));
    },
    async get(id) {
      const r = rows.get(id);
      return r ? { id: r.id, body: r.body, v: r.v } : null;
    },
    async put(item, expected, ttl) {
      const held = rows.get(item.id);
      if (expected === 0 ? held != null : held?.v !== expected) return false;
      rows.set(item.id, { ...item, ttl });
      return true;
    },
    async remove(id) {
      rows.delete(id);
    },
    async add(id, field) {
      const c = counts.get(id) ?? {};
      c[field] = (c[field] ?? 0) + 1;
      counts.set(id, c);
    },
    async counters(ids) {
      return Object.fromEntries(ids.filter((id) => counts.has(id)).map((id) => [id, { ...counts.get(id) }]));
    },
  };
}
