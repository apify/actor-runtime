import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Keeps login tokens out of the data directory in plain text (`system.md`): a token is stored only as its
 * SHA-256 (enough to recognise a login) and sealed with AES-256-GCM under a key file the runtime creates in
 * the data directory, readable only by the runtime's own user. Root and that user can still open the
 * tokens; any other user on the host, reading the rest of the data directory, cannot.
 */

const KEY_FILE = '.token-vault.key';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SEALED_PREFIX = 'v1:';

let key: Buffer | undefined;

/** Loads the key from `dataDir`, creating it on first start. `created` with users already stored means the
 * previous key file was deleted, so their sealed tokens no longer open. */
export function initTokenVault(dataDir: string): { created: boolean } {
	mkdirSync(dataDir, { recursive: true });
	const path = join(dataDir, KEY_FILE);
	try {
		const existing = readFileSync(path);
		if (existing.length !== KEY_BYTES) throw new Error(`${path} is not a ${KEY_BYTES}-byte key`);
		// Re-tightened on every start: a copy or restore of the data directory may have loosened it.
		chmodSync(path, 0o600);
		key = existing;
		return { created: false };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	const fresh = randomBytes(KEY_BYTES);
	// `wx`: never overwrite a key another process wrote in the meantime - that would orphan its tokens.
	writeFileSync(path, fresh, { mode: 0o600, flag: 'wx' });
	// `mode` above is narrowed by the umask only, never widened; this pins it whatever the umask.
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
