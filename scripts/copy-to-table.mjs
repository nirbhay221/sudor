/**
 * Copy the people file into the DynamoDB table, once, when a server moves over.
 *
 *   SUDOR_STORE=dynamodb SUDOR_DATA=/var/lib/sudor/people.json node scripts/copy-to-table.mjs
 *
 * Run it on the server, with the server's own data key in the environment, after
 * `npm run build` and before switching the server to the table. Each record is sealed
 * for its own id. A record already on the table is left as it is, so running it a
 * second time changes nothing. The file is only read, and kept, so going back is
 * a matter of switching the setting off again.
 */
const store = await import('../dist/store.js');
const { copied, already } = await store.copyFileToTable();
console.log(`copied ${copied} record${copied === 1 ? '' : 's'} to the table; ${already} already there`);
