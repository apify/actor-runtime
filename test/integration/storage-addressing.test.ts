/**
 * Storage addressing by name (`api.md`'s "Storage id encoding"): `~name`, `username~name` and
 * `userId~name` in place of a storage id, on all three storage types and every route that takes the
 * id - with the platform's own rules (apify-core's `ResourceIdGetter`): a bare name is an id, names and
 * usernames match case-insensitively, an empty name is `400 invalid-request`, and a reference to any
 * owner other than the caller is `404 record-not-found` (the restricted view - see
 * `test/integration/api-fallback.test.ts` for how that same `404` then feeds the upstream relay).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApifyClient } from 'apify-client';
import axios from 'axios';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';

describe('storage addressing by username~name', () => {
	let server: TestServerHandle;
	let me: { id: string; username: string };

	beforeEach(async () => {
		server = await startTestServer();
		const user = await server.client.user('me').get();
		me = { id: user.id, username: user.username! };
	});

	afterEach(async () => {
		await server.close();
	});

	async function raw(method: 'get' | 'put' | 'post' | 'delete', path: string, body?: unknown, token = server.token) {
		return axios.request({
			method,
			url: `${server.baseUrl}${path}`,
			data: body,
			headers: {
				Authorization: `Bearer ${token}`,
				...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
			},
			validateStatus: () => true,
		});
	}

	describe('datasets', () => {
		it('resolves ~name, username~name and userId~name to the same dataset as the id, case-insensitively', async () => {
			const created = await server.client.datasets().getOrCreate('My-Results');
			await server.client.dataset(created.id).pushItems([{ n: 1 }]);

			for (const ref of [
				'~My-Results',
				'~my-results',
				`${me.username}~My-Results`,
				`${me.username.toUpperCase()}~my-results`,
				`${me.id}~My-Results`,
			]) {
				const byName = await server.client.dataset(ref).get();
				expect(byName?.id, ref).toBe(created.id);
				expect(byName?.name, ref).toBe('My-Results');

				const items = await server.client.dataset(ref).listItems();
				expect(items.items, ref).toEqual([{ n: 1 }]);
			}
		});

		it("the platform's canonical `username/name` works when percent-encoded into the path segment", async () => {
			const created = await server.client.datasets().getOrCreate('slash-addressed');
			const res = await raw('get', `/v2/datasets/${encodeURIComponent(`${me.username}/slash-addressed`)}`);
			expect(res.status).toBe(200);
			expect(res.data.data.id).toBe(created.id);
		});

		it('a bare name without a separator is an id lookup, so it is record-not-found - unlike :actorId', async () => {
			await server.client.datasets().getOrCreate('bare-name');
			const res = await raw('get', '/v2/datasets/bare-name');
			expect(res.status).toBe(404);
			expect(res.data.error.type).toBe('record-not-found');
		});

		it('writes by name reach the same storage: push, rename, statistics, delete', async () => {
			const created = await server.client.datasets().getOrCreate('to-rename');

			const pushed = await raw('post', '/v2/datasets/~to-rename/items', [{ a: 1 }, { a: 2 }]);
			expect(pushed.status).toBe(201);
			expect((await server.client.dataset(created.id).get())?.itemCount).toBe(2);

			expect((await raw('get', '/v2/datasets/~to-rename/statistics')).status).toBe(200);

			const renamed = await raw('put', '/v2/datasets/~to-rename', { name: 'renamed' });
			expect(renamed.status).toBe(200);
			expect(renamed.data.data.id).toBe(created.id);
			expect(renamed.data.data.name).toBe('renamed');
			// The old name no longer resolves, the new one does.
			expect((await raw('get', '/v2/datasets/~to-rename')).status).toBe(404);
			expect((await raw('get', '/v2/datasets/~renamed')).data.data.id).toBe(created.id);

			const deleted = await raw('delete', `/v2/datasets/${me.username}~renamed`);
			expect(deleted.status).toBe(204);
			expect(await server.client.dataset(created.id).get()).toBeUndefined();
		});
	});

	describe('key-value stores', () => {
		it('resolves every store route by name, including records', async () => {
			const created = await server.client.keyValueStores().getOrCreate('kv-named');
			await server.client.keyValueStore(created.id).setRecord({ key: 'greeting', value: { hi: true } });

			const info = await server.client.keyValueStore('~kv-named').get();
			expect(info?.id).toBe(created.id);

			const record = await server.client.keyValueStore(`${me.username}~KV-NAMED`).getRecord('greeting');
			expect(record?.value).toEqual({ hi: true });

			const keys = await server.client.keyValueStore(`${me.id}~kv-named`).listKeys();
			expect(keys.items.map((k) => k.key)).toEqual(['greeting']);

			const head = await axios.head(`${server.baseUrl}/v2/key-value-stores/~kv-named/records/greeting`, {
				headers: { Authorization: `Bearer ${server.token}` },
				validateStatus: () => true,
			});
			expect(head.status).toBe(200);

			await server.client.keyValueStore('~kv-named').setRecord({ key: 'second', value: 'x' });
			expect((await server.client.keyValueStore(created.id).getRecord('second'))?.value).toBe('x');

			await server.client.keyValueStore('~kv-named').deleteRecord('greeting');
			expect(await server.client.keyValueStore(created.id).getRecord('greeting')).toBeUndefined();
		});
	});

	describe('request queues', () => {
		it('resolves every queue route by name', async () => {
			const created = await server.client.requestQueues().getOrCreate('rq-named');

			const info = await server.client.requestQueue('~rq-named').get();
			expect(info?.id).toBe(created.id);

			const added = await server.client
				.requestQueue(`${me.username}~rq-named`)
				.addRequest({ url: 'https://example.com', uniqueKey: 'https://example.com' });
			expect(added.wasAlreadyPresent).toBe(false);

			const head = await server.client.requestQueue(`${me.id}~RQ-NAMED`).listHead();
			expect(head.items.map((r) => r.url)).toEqual(['https://example.com']);

			const byId = await server.client.requestQueue(created.id).get();
			expect(byId?.totalRequestCount).toBe(1);
		});
	});

	describe('platform error shapes', () => {
		it('an empty name (`username~`, `~`) is 400 invalid-request on every storage type', async () => {
			for (const path of [
				`/v2/datasets/${me.username}~`,
				'/v2/datasets/~',
				'/v2/key-value-stores/~/keys',
				`/v2/request-queues/${me.id}~/head`,
			]) {
				const res = await raw('get', path);
				expect(res.status, path).toBe(400);
				expect(res.data.error.type, path).toBe('invalid-request');
				expect(res.data.error.message, path).toBe('Resource name parameter cannot be empty');
			}
		});

		it('a name the caller has no storage of that type under is record-not-found - types never cross', async () => {
			await server.client.datasets().getOrCreate('only-a-dataset');
			const res = await raw('get', '/v2/key-value-stores/~only-a-dataset');
			expect(res.status).toBe(404);
			expect(res.data.error.type).toBe('record-not-found');
		});
	});

	describe('restricted view across users', () => {
		it("another user's storage is record-not-found by username and by user id, even though it exists", async () => {
			const clientB = new ApifyClient({ baseUrl: server.baseUrl, token: 'addressing-user-b', maxRetries: 0 });
			const userB = await clientB.user('me').get();
			const storeB = await clientB.keyValueStores().getOrCreate('shared-name');
			await clientB.keyValueStore(storeB.id).setRecord({ key: 'k', value: 'b' });

			// B can address it by every named form...
			expect((await clientB.keyValueStore(`${userB.username}~shared-name`).get())?.id).toBe(storeB.id);

			// ...the caller (A) cannot, and neither can an unknown username - all the same 404.
			for (const ref of [`${userB.username}~shared-name`, `${userB.id}~shared-name`, 'nobody-here~shared-name']) {
				const res = await raw('get', `/v2/key-value-stores/${ref}`);
				expect(res.status, ref).toBe(404);
				expect(res.data.error.type, ref).toBe('record-not-found');
				const record = await raw('get', `/v2/key-value-stores/${ref}/records/k`);
				expect(record.status, ref).toBe(404);
			}

			// `~shared-name` is *each* caller's own: A has none yet, then gets their own, distinct one.
			expect((await raw('get', '/v2/key-value-stores/~shared-name')).status).toBe(404);
			const storeA = await server.client.keyValueStores().getOrCreate('shared-name');
			expect(storeA.id).not.toBe(storeB.id);
			expect((await server.client.keyValueStore('~shared-name').get())?.id).toBe(storeA.id);
			expect((await clientB.keyValueStore('~shared-name').get())?.id).toBe(storeB.id);
		});
	});

	describe('name uniqueness is case-insensitive, like the platform', () => {
		it('getOrCreate with a differently-cased name returns the existing storage, keeping its original casing', async () => {
			const first = await server.client.datasets().getOrCreate('Case-Test');
			const second = await server.client.datasets().getOrCreate('case-test');
			expect(second.id).toBe(first.id);
			expect(second.name).toBe('Case-Test');
			expect((await server.client.datasets().list()).items).toHaveLength(1);
		});
	});
});
