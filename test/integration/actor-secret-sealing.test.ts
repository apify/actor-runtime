import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { filesContaining } from './helpers/data-dir.js';
import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { getRegistries } from '../../src/storage/registries.js';
import { openKeyValueStore } from '../../src/storage/open.js';
import { initTokenVault } from '../../src/services/token-vault.js';
import { sealStoredCredentials } from '../../src/services/users.js';
import { decryptedEnvVars, ensureSecretKeys } from '../../src/services/secrets.js';

const SECRET_VALUE = 'my-secret-env-value-123';

interface RawActor {
	modifiedAt: string;
	secretKeys: { passphrase?: string; sealedPassphrase?: string };
}

describe("Actors' secret passphrases at rest", () => {
	let server: TestServerHandle;
	let actorId: string;

	const rawActor = async () => (await (await openKeyValueStore('__ACTORS__')).getValue(actorId)) as RawActor;
	const actor = async () => (await getRegistries().actors.get(actorId))!;

	beforeEach(async () => {
		server = await startTestServer();
		initTokenVault(server.dataDir);
		const created = await server.client.actors().create({
			name: 'secret-actor',
			versions: [
				{
					versionNumber: '0.0',
					sourceType: 'SOURCE_FILES',
					buildTag: 'latest',
					sourceFiles: [],
					envVars: [{ name: 'MY_SECRET', value: SECRET_VALUE, isSecret: true }],
				},
			],
		} as never);
		actorId = created.id;
	});

	afterEach(async () => {
		await server.close();
	});

	const secretValue = async () => decryptedEnvVars(await actor(), (await actor()).versions[0]!.envVars)[0]!.value;

	it('the passphrase is stored sealed, never in plain text, and the secret still decrypts', async () => {
		const { passphrase } = (await actor()).secretKeys!;
		const stored = await rawActor();

		expect(stored.secretKeys.passphrase).toBeUndefined();
		expect(stored.secretKeys.sealedPassphrase).toMatch(/^v1:/);
		expect(await filesContaining(server.dataDir, passphrase)).toEqual([]);
		expect(await filesContaining(server.dataDir, SECRET_VALUE)).toEqual([]);
		expect(await secretValue()).toBe(SECRET_VALUE);
	});

	it('an Actor stored with a plain-text passphrase is rewritten sealed on start, modifiedAt untouched', async () => {
		const decoded = await actor();
		await (await openKeyValueStore('__ACTORS__')).setValue(actorId, decoded);
		expect((await rawActor()).secretKeys.passphrase).toBe(decoded.secretKeys!.passphrase);

		await sealStoredCredentials();

		const stored = await rawActor();
		expect(stored.secretKeys.passphrase).toBeUndefined();
		expect(stored.modifiedAt).toBe(decoded.modifiedAt);
		expect(await filesContaining(server.dataDir, decoded.secretKeys!.passphrase)).toEqual([]);
		expect(await secretValue()).toBe(SECRET_VALUE);
	});

	it('with the key file deleted, the secret fails with a clear error, and the start leaves the record alone', async () => {
		const before = await rawActor();
		await rm(join(server.dataDir, '.token-vault.key'));
		initTokenVault(server.dataDir);

		await sealStoredCredentials();
		expect(await rawActor()).toEqual(before);
		expect((await actor()).secretKeys).toBeUndefined();
		await expect(secretValue()).rejects.toThrow(/MY_SECRET.*cannot be decrypted.*Set it again/);

		// A new key pair (made by the next run or write) does not open the old secret either - same error.
		const rekeyed = await ensureSecretKeys(await actor());
		expect(() => decryptedEnvVars(rekeyed, rekeyed.versions[0]!.envVars)).toThrow(/cannot be decrypted/);
	});

	it('a sealed passphrase copied onto another Actor does not open there', async () => {
		const store = await openKeyValueStore('__ACTORS__');
		await store.setValue('other-actor-id', { ...(await rawActor()), id: 'other-actor-id' });

		expect((await getRegistries().actors.get('other-actor-id'))?.secretKeys).toBeUndefined();
	});
});
