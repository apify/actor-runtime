import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Keeps login tokens out of the data directory in plain text (`storage.md`): a token is stored only as
 * its SHA-256 (enough to recognise a login) and sealed with AES-256-GCM under a key that lives in its own
 * directory, never inside the data directory. In the image that directory is a Docker volume, so a scan of
 * the host's files finds neither the tokens nor the key that opens them.
 */

const KEY_FILE = 'token-vault.key';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SEALED_PREFIX = 'v1:';

let key: Buffer | undefined;

/** Loads the key from `keyDir`, creating it on first start. `created` with users already stored means the
 * previous key is gone (e.g. the key volume was not mounted), so their sealed tokens no longer open. */
export function initTokenVault(keyDir: string): { created: boolean } {
	mkdirSync(keyDir, { recursive: true, mode: 0o700 });
	const path = join(keyDir, KEY_FILE);
	try {
		const existing = readFileSync(path);
		if (existing.length !== KEY_BYTES) throw new Error(`${path} is not a ${KEY_BYTES}-byte key`);
		key = existing;
		return { created: false };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	const fresh = randomBytes(KEY_BYTES);
	// `wx`: never overwrite a key another process wrote in the meantime - that would orphan its tokens.
	writeFileSync(path, fresh, { mode: 0o600, flag: 'wx' });
	chmodSync(path, 0o600);
	key = fresh;
	return { created: true };
}

function requireKey(): Buffer {
	if (!key) throw new Error('initTokenVault() has not been called yet.');
	return key;
}

/** Unsalted on purpose: lookups must match across restarts and even after the key is lost. API tokens
 * are long random strings, so the hash cannot be reversed by guessing. */
export function hashToken(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** `context` (the record id) is bound in as associated data: a sealed value copied onto another record
 * does not open there. */
export function seal(value: unknown, context: string): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv('aes-256-gcm', requireKey(), iv);
	cipher.setAAD(Buffer.from(context, 'utf8'));
	const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
	return SEALED_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

/** `undefined` when the value was sealed under another key, for another record, or was tampered with. */
export function unseal<T>(sealed: string, context: string): T | undefined {
	if (!sealed.startsWith(SEALED_PREFIX)) return undefined;
	const raw = Buffer.from(sealed.slice(SEALED_PREFIX.length), 'base64');
	if (raw.length < IV_BYTES + TAG_BYTES) return undefined;
	try {
		const decipher = createDecipheriv('aes-256-gcm', requireKey(), raw.subarray(0, IV_BYTES));
		decipher.setAAD(Buffer.from(context, 'utf8'));
		decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
		const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
		return JSON.parse(plain.toString('utf8')) as T;
	} catch {
		return undefined;
	}
}
