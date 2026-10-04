/**
 * What account linking remembers, and what it refuses to forget by accident.
 *
 * Three separate weaknesses lived in auth.ts, and all three were honest about
 * themselves in comments and therefore easy to leave alone.
 *
 * 1. Linking was a name. The consent page took "Your name", lowercased it, and that
 *    string became the subject every tool scoped its data to. So typing `jordan`
 *    into the page made you `acct:jordan`, with Jordan's medication list, their
 *    address and their family's email. The comment called the page "deliberately a
 *    stub" because a farm has no user database and a fake one would be theatre.
 *    That is fair as far as it goes, and it stops being fair the moment the record
 *    behind the name is somebody's prescriptions. A passphrase is not a user
 *    database. It is the smallest thing that makes the name stop being enough.
 *
 * 2. Every token lived in a Map. A deploy is a restart, so shipping any fix signed
 *    every linked account out, and an add-on that has to be re-linked by every
 *    customer on every release cannot be certified or kept.
 *
 * 3. A replayed refresh token was simply refused. Rotation without reuse detection
 *    gives up most of what rotation is for: the point is that a stolen token and
 *    the legitimate client collide, and that the collision is noticed.
 *    RFC 9700, the OAuth 2.0 security best current practice published as BCP 240,
 *    says public clients must use rotation or sender-constrained tokens, and
 *    describes revoking everything associated with the grant when an old one turns
 *    up again.
 *
 * What is stored, and in what form.
 *
 * Tokens are never written down. A token is 256 bits of randomness, so a plain
 * SHA-256 of it is the right thing to keep: it cannot be reversed, there is nothing
 * for a slow hash to defend, and a copy of the file cannot be replayed against the
 * server. Only the hash is looked up.
 *
 * Passphrases get the opposite treatment, because a human chose them. scrypt with a
 * per-credential salt, at the OWASP cost settings of N=2^16, r=8, p=2, which is 64
 * MiB and lands near a third of a second. The parameters are stored with each
 * credential so they can be raised later without invalidating anybody.
 *
 * The file is sealed by vault.ts like the people file, under its own purpose label,
 * so a copy of one cannot be passed off as the other.
 *
 * Deliberate limits, said plainly.
 *
 * First use claims a name. There is no email to verify and no user database behind
 * this, so whoever links a name first sets its passphrase. That closes the silent
 * takeover, and it leaves squatting: somebody can claim a name before its owner
 * does, and the owner will then be refused. It fails visibly instead of quietly,
 * which is the improvement being made, and the fix is a real identity provider.
 *
 * Accounts that linked before this existed have data and no credential. The first
 * person to present that name sets its passphrase. There is no way to tell the
 * rightful owner from anybody else, and pretending otherwise would be worse.
 */

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import * as vault from './vault.js';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PATH = resolve(process.env.SUDOR_AUTH_DATA ?? './data/auth.json');
const PURPOSE = 'sudor:auth:v1';

export type TokenRec = { subject: string; clientId: string; expires: number };
type Cred = { salt: string; hash: string; N: number; r: number; p: number; at: string };

const COST = { N: 2 ** 16, r: 8, p: 2 };
/** scrypt needs about 128*N*r bytes; the default ceiling of 32 MiB would refuse it. */
const MAXMEM = 256 * 1024 * 1024;
const KEYLEN = 32;

export const MIN_PASSPHRASE = 8;
const MAX_PASSPHRASE = 128;

const FAILURES_BEFORE_LOCK = 5;
/**
 * Wrong answers are counted per name AND per address they came from.
 *
 * They used to be counted per name alone, which let anybody lock a person out: type their name and five
 * wrong passphrases every fifteen minutes and the real owner never gets in. Counted per address, five wrong
 * answers lock out the address that gave them and nobody else. A second, much higher ceiling per name alone
 * stays, because without it a guesser with many addresses gets five tries from each for ever.
 */
const NAME_FAILURES_BEFORE_LOCK = 60;
const LOCK_MS = 15 * 60 * 1000;

/**
 * At most this many hashes in flight at once.
 *
 * Each one holds 64 MiB and a third of a second of a worker thread. Linking is rare
 * and a burst of it is either a bug or somebody trying to exhaust the box, so past
 * this the answer is "busy", and the memory is never allocated.
 */
const MAX_CONCURRENT_HASHES = 2;
let hashing = 0;

export const access = new Map<string, TokenRec>();
export const refresh = new Map<string, TokenRec>();
/** Refresh tokens already exchanged. Seeing one again means it was copied. */
export const spent = new Map<string, TokenRec>();
const credentials = new Map<string, Cred>();
const failures = new Map<string, { count: number; lockedUntil: number }>();

let loaded = false;

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

function quarantine(why: string): void {
  const aside = `${PATH}.corrupt-${Date.now()}`;
  renameSync(PATH, aside);
  console.error(`[auth] ${why} The file was set aside at ${aside} and linked accounts must link again.`);
}

/**
 * Read the file, failing closed on a configuration mistake and setting a damaged
 * file aside rather than overwriting it. Same reasoning as store.ts, and for the
 * same reason: a wrong key must never be able to erase what a right one would read.
 */
export function load(): void {
  if (loaded) return;
  loaded = true;
  if (!existsSync(PATH)) return;

  const raw = readFileSync(PATH, 'utf8');
  try {
    const opened = vault.open(raw, PURPOSE);
    const doc = JSON.parse(opened.plain) as {
      credentials?: Record<string, Cred>;
      access?: Record<string, TokenRec>;
      refresh?: Record<string, TokenRec>;
      spent?: Record<string, TokenRec>;
    };
    for (const [k, v] of Object.entries(doc.credentials ?? {})) credentials.set(k, v);
    for (const [k, v] of Object.entries(doc.access ?? {})) access.set(k, v);
    for (const [k, v] of Object.entries(doc.refresh ?? {})) refresh.set(k, v);
    for (const [k, v] of Object.entries(doc.spent ?? {})) spent.set(k, v);
    prune();
    if (vault.encryptionOn() && (!opened.wasSealed || !vault.isCurrentKey(opened.keyId))) save();
  } catch (err) {
    if (err instanceof vault.VaultError && (err.code === 'no_key' || err.code === 'unknown_key')) {
      loaded = false;
      throw err;
    }
    quarantine(err instanceof vault.VaultError ? `The auth file failed verification (${err.code}).` : 'The auth file could not be parsed.');
  }
}

export function save(): void {
  load();
  mkdirSync(dirname(PATH), { recursive: true, mode: 0o700 });
  const doc = {
    credentials: Object.fromEntries(credentials),
    access: Object.fromEntries(access),
    refresh: Object.fromEntries(refresh),
    spent: Object.fromEntries(spent),
  };
  const text = vault.encryptionOn() ? JSON.stringify(doc) : JSON.stringify(doc, null, 2);
  const tmp = `${PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, vault.sealIfConfigured(text, PURPOSE), { mode: 0o600 });
  renameSync(tmp, PATH);
}

export function prune(at = Date.now()): void {
  for (const map of [access, refresh, spent]) for (const [k, v] of map) if (v.expires < at) map.delete(k);
}

/**
 * Everything issued to one subject through one client, gone.
 *
 * Called when a spent refresh token is presented again. Which of the two parties
 * holding it is the thief is not something the server can know, so it does not
 * try: both lose the grant, and the legitimate customer links again. That is a
 * small annoyance set against a stranger keeping a health record open.
 */
export function revokeFamily(subject: string, clientId: string): number {
  let n = 0;
  for (const map of [access, refresh, spent]) {
    for (const [k, v] of map) {
      if (v.subject === subject && v.clientId === clientId) {
        map.delete(k);
        n += 1;
      }
    }
  }
  save();
  return n;
}

export type Verdict =
  | { kind: 'claimed' }
  | { kind: 'ok' }
  | { kind: 'wrong' }
  | { kind: 'weak'; reason: string }
  | { kind: 'locked'; retryAfterSeconds: number }
  | { kind: 'busy' };

/** The name as it is stored, so "Jordan " and "jordan" cannot be two people. */
export const normaliseName = (raw: unknown): string => String(raw ?? '').trim().toLowerCase().slice(0, 64);

async function derive(passphrase: string, salt: Buffer, p: { N: number; r: number; p: number }): Promise<Buffer> {
  return scrypt(passphrase.normalize('NFKC'), salt, KEYLEN, { ...p, maxmem: MAXMEM });
}

/**
 * Let a name link, on the first use or with the passphrase it was claimed with.
 *
 * Order matters and is deliberate. A locked name is refused before any hashing, so
 * hammering a locked account costs the attacker a request and costs the server
 * nothing. A busy server refuses before allocating. Only then is a hash computed,
 * and a wrong answer counts against the name.
 */
export async function claimOrVerify(name: string, passphrase: string, source = ''): Promise<Verdict> {
  load();
  if (!name) return { kind: 'wrong' };

  // This address's own count for this name, and the name's count across every address.
  const mine = `${name}|${source}`;
  const all = `${name}|*`;
  const f = failures.get(mine);
  const everyone = failures.get(all);
  for (const held of [f, everyone]) {
    if (held && held.lockedUntil > Date.now()) {
      return { kind: 'locked', retryAfterSeconds: Math.ceil((held.lockedUntil - Date.now()) / 1000) };
    }
  }

  // The rules are checked before looking at whether the name exists, and they are the
  // same for everyone. Checking them only for unclaimed names would make the page an
  // oracle: a short passphrase would be called "too short" for a free name and
  // "did not match" for a taken one, and anybody could list who has linked. Nothing a
  // valid credential holds can break these rules, so applying them to existing names
  // too costs nothing and leaks nothing.
  if (passphrase.length < MIN_PASSPHRASE) {
    return { kind: 'weak', reason: `A passphrase is at least ${MIN_PASSPHRASE} characters.` };
  }
  if (passphrase.length > MAX_PASSPHRASE) return { kind: 'weak', reason: 'That passphrase is too long.' };
  if (passphrase.toLowerCase() === name) return { kind: 'weak', reason: 'The passphrase cannot be your name.' };

  const existing = credentials.get(name);

  if (hashing >= MAX_CONCURRENT_HASHES) return { kind: 'busy' };
  hashing += 1;
  try {
    if (!existing) {
      const salt = randomBytes(16);
      const hash = await derive(passphrase, salt, COST);
      // Two first-time claims for one name can be in flight together. The second
      // to finish finds the name taken and is treated as an ordinary wrong answer.
      if (credentials.has(name)) return { kind: 'wrong' };
      credentials.set(name, {
        salt: salt.toString('base64'),
        hash: hash.toString('base64'),
        ...COST,
        at: new Date().toISOString(),
      });
      save();
      return { kind: 'claimed' };
    }

    const given = await derive(passphrase, Buffer.from(existing.salt, 'base64'), existing);
    const want = Buffer.from(existing.hash, 'base64');
    const ok = given.length === want.length && timingSafeEqual(given, want);

    if (ok) {
      // Only this address's count is cleared. Somebody else's wrong guesses are not forgiven by the owner signing in.
      failures.delete(mine);
      return { kind: 'ok' };
    }

    const bump = (key: string, held: { count: number; lockedUntil: number } | undefined, limit: number) => {
      const count = (held && held.lockedUntil <= Date.now() && held.count >= limit ? 0 : held?.count ?? 0) + 1;
      failures.set(key, { count, lockedUntil: count >= limit ? Date.now() + LOCK_MS : 0 });
    };
    bump(mine, f, FAILURES_BEFORE_LOCK);
    bump(all, everyone, NAME_FAILURES_BEFORE_LOCK);
    // Counts are only ever added by wrong answers, so the book of them is bounded here.
    if (failures.size > 50_000) failures.delete(failures.keys().next().value as string);
    return { kind: 'wrong' };
  } finally {
    hashing -= 1;
  }
}

export function hasCredential(name: string): boolean {
  load();
  return credentials.has(name);
}

/** For /health: counts only, never a name. */
export function status(): { credentials: number; access: number; refresh: number } {
  load();
  return { credentials: credentials.size, access: access.size, refresh: refresh.size };
}

export function resetForTest(): void {
  access.clear();
  refresh.clear();
  spent.clear();
  credentials.clear();
  failures.clear();
  hashing = 0;
  loaded = false;
}
