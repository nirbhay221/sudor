/**
 * Health data at rest.
 *
 * Everything this server remembers about a person, the medicines they take, the
 * conditions they live with, where they live and who to email when it goes wrong,
 * was written to a JSON file in the clear. The README has a whole section arguing
 * about how long that record is kept and never once says it is readable by anything
 * on the box. For this class of data that was the sharpest weakness in either
 * project, and it is the one thing an auditor asks about first.
 *
 * This seals the file with AES-256-GCM. The choices, each of which has a
 * failure mode worth naming:
 *
 * A fresh random 96 bit nonce per write. GCM's one catastrophic mistake is reusing
 * a nonce under the same key, which leaks the XOR of two plaintexts and exposes the
 * authentication key. Random 12 byte nonces are safe for far more writes than this
 * server will ever make, and a test asserts two seals of identical text differ.
 *
 * The envelope carries the key id, nonce and tag beside the ciphertext, so nothing
 * needed to decrypt is forgotten and nothing secret is stored with it. The key
 * itself lives outside the file, in the environment, populated from a secrets
 * manager at boot rather than baked into an image.
 *
 * Additional authenticated data binds each file to its purpose. A store file
 * cannot be swapped in as the credentials file, or the reverse, because the tag
 * covers a label the attacker would have to forge.
 *
 * A key id, the first eight hex characters of the key's SHA-256, so more than one
 * key can be live at once. Rotation is then a deploy rather than a migration: set
 * the new key, keep the old one as `_PREVIOUS`, and the next write re-seals under
 * the new one.
 *
 * ---
 *
 * The property that matters most is not the cipher. It is what happens when
 * decryption fails.
 *
 * The plaintext version of this loader had a line that read `catch { cache = {} }`.
 * A file that would not parse became an empty database, and the next ordinary write
 * overwrote the unreadable file with the empty one. Corruption silently deleted
 * everyone. Encryption makes that much worse, because a wrong key is now a
 * completely ordinary operator mistake, and "wrong key" and "corrupt file" look
 * identical to a loader that swallows the error.
 *
 * So the two are kept apart, and neither is allowed to wipe anything:
 *
 *   No key configured, or a key id this process does not hold: the file is fine and
 *   the configuration is wrong. Throw, refuse to start, touch nothing.
 *
 *   The right key, and the tag does not verify: the bytes were changed or damaged.
 *   The caller quarantines the file, which is a rename and keeps every byte, and
 *   carries on empty with a loud log line.
 *
 * Off unless a key is set, so development and the currently deployed build keep
 * working unchanged. `SUDOR_REQUIRE_ENCRYPTION=on` turns "no key" into a boot
 * failure, which is what a production deployment should set.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';
const NONCE_BYTES = 12;

export type VaultErrorCode =
  /** The file is sealed and no key is configured. A configuration error. */
  | 'no_key'
  /** The file names a key id this process does not hold. A configuration error. */
  | 'unknown_key'
  /** Right key, bad tag. The bytes were damaged or changed. */
  | 'auth_failed'
  /** Looks like an envelope but is not a well formed one. */
  | 'malformed'
  /** A configured key is not 32 bytes of base64. */
  | 'bad_key';

export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

type Key = { id: string; bytes: Buffer };

type Envelope = { v: 1; alg: typeof ALG; kid: string; iv: string; tag: string; ct: string };

let memo: { signature: string; keys: Key[] } | null = null;

function parseKey(b64: string, label: string): Key {
  const bytes = Buffer.from(b64.trim(), 'base64');
  if (bytes.length !== 32) {
    throw new VaultError(
      'bad_key',
      `${label} must be 32 bytes encoded as base64 (got ${bytes.length}). Generate one with: ` +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return { id: createHash('sha256').update(bytes).digest('hex').slice(0, 8), bytes };
}

/**
 * The live keys, current first. Read from the environment on each call and
 * memoised on the raw strings, so a test can change them and a running server pays
 * nothing.
 */
function keys(): Key[] {
  const current = (process.env.SUDOR_DATA_KEY ?? '').trim();
  const previous = (process.env.SUDOR_DATA_KEY_PREVIOUS ?? '').trim();
  const signature = `${current}|${previous}`;
  if (memo?.signature === signature) return memo.keys;

  const out: Key[] = [];
  if (current) out.push(parseKey(current, 'SUDOR_DATA_KEY'));
  for (const [i, p] of previous.split(',').map((s) => s.trim()).filter(Boolean).entries()) {
    out.push(parseKey(p, `SUDOR_DATA_KEY_PREVIOUS[${i}]`));
  }
  memo = { signature, keys: out };
  return out;
}

/** Whether anything written from here on will be sealed. */
export function encryptionOn(): boolean {
  return (process.env.SUDOR_DATA_KEY ?? '').trim().length > 0;
}

/** Refuse to boot without a key when the deployment says one is required. */
export function assertRequirementMet(): void {
  const required = (process.env.SUDOR_REQUIRE_ENCRYPTION ?? 'off').toLowerCase() === 'on';
  if (required && !encryptionOn()) {
    throw new VaultError(
      'no_key',
      'SUDOR_REQUIRE_ENCRYPTION is on but SUDOR_DATA_KEY is not set. Refusing to start, because ' +
        'this server would otherwise store medications and locations in the clear.',
    );
  }
  // Parsing validates every configured key now rather than on the first write.
  keys();
}

export function looksSealed(text: string): boolean {
  if (!text.startsWith('{')) return false;
  try {
    const e = JSON.parse(text) as Partial<Envelope>;
    return e.v === 1 && e.alg === ALG && typeof e.ct === 'string' && typeof e.iv === 'string';
  } catch {
    return false;
  }
}

/**
 * Seal text under the current key, or return it unchanged when no key is set.
 *
 * Returning the plaintext when encryption is off is deliberate: callers write
 * whatever this returns, so development needs no special path, and the loader can
 * tell the two apart by looking at the file.
 */
export function sealIfConfigured(plain: string, purpose: string): string {
  const [key] = keys();
  if (!key) return plain;

  const iv = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALG, key.bytes, iv);
  cipher.setAAD(Buffer.from(purpose));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const env: Envelope = {
    v: 1,
    alg: ALG,
    kid: key.id,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
  return JSON.stringify(env);
}

export type Opened = { plain: string; wasSealed: boolean; keyId: string | null };

/**
 * Read a file's text, whether or not it is sealed.
 *
 * A plaintext file is returned as it is with `wasSealed: false`, which is how a
 * deployment that has just been given a key finds out it has data to migrate.
 * Throws a VaultError otherwise, and never returns something it could not verify.
 */
export function open(text: string, purpose: string): Opened {
  if (!looksSealed(text)) return { plain: text, wasSealed: false, keyId: null };

  let env: Envelope;
  try {
    env = JSON.parse(text) as Envelope;
  } catch {
    throw new VaultError('malformed', 'The sealed file could not be parsed.');
  }

  const held = keys();
  if (held.length === 0) {
    throw new VaultError(
      'no_key',
      `This data is sealed under key ${env.kid} and SUDOR_DATA_KEY is not set. Nothing has been changed.`,
    );
  }
  const key = held.find((k) => k.id === env.kid);
  if (!key) {
    throw new VaultError(
      'unknown_key',
      `This data is sealed under key ${env.kid}, which is not SUDOR_DATA_KEY or in ` +
        `SUDOR_DATA_KEY_PREVIOUS. Nothing has been changed.`,
    );
  }

  try {
    const iv = Buffer.from(env.iv, 'base64');
    const tag = Buffer.from(env.tag, 'base64');
    if (iv.length !== NONCE_BYTES || tag.length !== 16) {
      throw new VaultError('malformed', 'The sealed file has a nonce or tag of the wrong size.');
    }
    const decipher = createDecipheriv(ALG, key.bytes, iv);
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString('utf8');
    return { plain, wasSealed: true, keyId: key.id };
  } catch (err) {
    if (err instanceof VaultError) throw err;
    // Node reports every GCM failure the same way, and that is correct: the caller
    // is not entitled to know whether the tag, the data or the label was wrong.
    throw new VaultError('auth_failed', 'The sealed file failed authentication and was not read.');
  }
}

/** Whether a sealed file was written under something other than the current key. */
export function isCurrentKey(keyId: string | null): boolean {
  const [current] = keys();
  return !!current && keyId === current.id;
}

export function status(): { encryptedAtRest: boolean; keyId: string | null; previousKeys: number } {
  const held = keys();
  return {
    encryptedAtRest: encryptionOn(),
    keyId: held[0]?.id ?? null,
    previousKeys: Math.max(0, held.length - 1),
  };
}

export function resetForTest(): void {
  memo = null;
}
