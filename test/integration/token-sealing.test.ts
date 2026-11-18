import { chmod, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApifyClient } from 'apify-client';

import { filesContaining } from './helpers/data-dir.js';
import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { getRegistries } from '../../src/storage/registries.js';
import { openKeyValueStore } from '../../src/storage/open.js';
import { initTokenVault } from '../../src/services/token-vault.js';
import { resetUsersForTests, sealStoredCredentials, tokenOf } from '../../src/services/users.js';

describe('login tokens at rest', () => {
	let server: TestServerHandle;

	beforeEach(async () => {
		server = await startTestServer(undefined, 'apify_api_never-on-disk-0123456789');
		initTokenVault(server.dataDir);
	});

	afterEach(async () => {
		await server.close();
	});

	it('the key file sits in the data directory, readable by its owner only, even after its mode was loosened', async () => {
		const keyFile = join(server.dataDir, '.token-vault.key');
		expect((await stat(keyFile)).mode & 0o777).toBe(0o600);

		await chmod(keyFile, 0o644);
		expect(initTokenVault(server.dataDir).created).toBe(false);
		expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
	});

	it('a token, current or earlier, and a proxy password never appear in the data directory', async () => {
		const me = await server.client.user('me').get();
		await getRegistries().users.update(me.id, (user) => user && { ...user, proxyPassword: 'proxy-secret-42' });
		await server.client.actors().create({ name: 'some-actor' });

		expect(await filesContaining(server.dataDir, server.token)).toEqual([]);
		expect(await filesContaining(server.dataDir, 'proxy-secret-42')).toEqual([]);
		const stored = await getRegistries().users.get(me.id);
		expect(stored?.token).toBe(server.token);
		expect(stored?.proxyPassword).toBe('proxy-secret-42');
	});

	it('a user stored with a plain-text token before sealing existed is rewritten sealed and still logs in', async () => {
		const legacy = {
			id: 'legacy-user-id',
			username: 'legacy-user',
			createdAt: new Date().toISOString(),
			token: 'legacy-plain-token',
			tokens: ['legacy-older-token', 'legacy-plain-token'],
			proxyPassword: 'legacy-proxy',
		};
		await (await openKeyValueStore('__USERS__')).setValue(legacy.id, legacy);

		await sealStoredCredentials();

		for (const secret of ['legacy-plain-token', 'legacy-older-token', 'legacy-proxy']) {
			expect(await filesContaining(server.dataDir, secret)).toEqual([]);
		}
		for (const token of ['legacy-plain-token', 'legacy-older-token']) {
			const client = new ApifyClient({ baseUrl: server.baseUrl, token, maxRetries: 0 });
			expect((await client.user('me').get()).id).toBe(legacy.id);
		}
	});

	it('with the key gone, logins still resolve and the next request restores the token', async () => {
		const me = await server.client.user('me').get();

		resetUsersForTests();
		await rm(join(server.dataDir, '.token-vault.key'));
		expect(initTokenVault(server.dataDir).created).toBe(true);
		expect(await sealStoredCredentials()).toEqual({ unreadableUsers: 1 });
		const orphaned = await getRegistries().users.get(me.id);
		expect(orphaned?.token).toBeUndefined();
		expect(() => tokenOf(orphaned!)).toThrow(/cannot be read/);

		expect((await server.client.user('me').get()).id).toBe(me.id);
		expect((await getRegistries().users.get(me.id))?.token).toBe(server.token);
	});

	it('a sealed value copied onto another user does not open there', async () => {
		const me = await server.client.user('me').get();
		const store = await openKeyValueStore('__USERS__');
		const raw = (await store.getValue(me.id)) as Record<string, unknown>;
		await store.setValue('someone-else', { ...raw, id: 'someone-else', tokenHashes: [] });

		expect((await getRegistries().users.get('someone-else'))?.token).toBeUndefined();
	});
});
