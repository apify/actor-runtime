/**
 * Covers the last-run shortcuts (`api.md`'s "Last-run shortcuts", `api/routes/last-run.ts`): the pick, every
 * sub-path re-dispatch, the error ladder, and the one-source rule against a stub upstream.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { ApifyClient } from 'apify-client';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { startStubUpstream, warmUpIdentity } from './helpers/stub-upstream.js';
import { setApiFallbackState } from '../../src/services/api-fallback.js';
import { createStorage } from '../../src/services/storages.js';
import { appendLog, flushLog } from '../../src/services/logs.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import type { JobStatus, RunRecord } from '../../src/storage/entities.js';

/** Three instants, oldest to newest, far enough apart that no test's clock can interleave them. */
const T1 = '2026-01-01T10:00:00.000Z';
const T2 = '2026-01-01T11:00:00.000Z';
const T3 = '2026-01-01T12:00:00.000Z';

interface SeedRunOptions {
	startedAt: string;
	status?: JobStatus;
	origin?: string;
}

/** Seeded straight into the registry: `startedAt`/`status`/`meta.origin` under the test's control, and no
 * background lifecycle to race (a run started through the API with the unavailable driver fails on its own,
 * whenever it gets there). */
async function seedRun(actor: { id: string; userId: string }, options: SeedRunOptions): Promise<RunRecord> {
	const [dataset, keyValueStore, requestQueue] = await Promise.all([
		createStorage(actor.userId, 'dataset'),
		createStorage(actor.userId, 'keyValueStore'),
		createStorage(actor.userId, 'requestQueue'),
	]);
	const status = options.status ?? 'SUCCEEDED';
	const run: RunRecord = {
		id: generateId(),
		userId: actor.userId,
		actorId: actor.id,
		buildId: generateId(),
		buildNumber: '0.0.1',
		status,
		startedAt: options.startedAt,
		finishedAt: status === 'RUNNING' || status === 'READY' ? undefined : options.startedAt,
		defaultDatasetId: dataset.id,
		defaultKeyValueStoreId: keyValueStore.id,
		defaultRequestQueueId: requestQueue.id,
		options: { memoryMbytes: 1024, timeoutSecs: 300 },
		meta: { origin: options.origin ?? 'API' },
	};
	await getRegistries().runs.set(run.id, run);
	return run;
}

describe('last-run shortcuts', () => {
	let server: TestServerHandle;
	let previousUpstreamUrl: string | undefined;

	beforeEach(async () => {
		server = await startTestServer();
		// Every first-seen token probes the configured upstream once; a dead address makes that fail instantly
		// instead of landing on a test's own stub and inflating its hit count.
		previousUpstreamUrl = process.env.APIFY_UPSTREAM_API_BASE_URL;
		process.env.APIFY_UPSTREAM_API_BASE_URL = 'http://127.0.0.1:1';
		await warmUpIdentity(server.baseUrl, server.token);
	});

	afterEach(async () => {
		if (previousUpstreamUrl === undefined) delete process.env.APIFY_UPSTREAM_API_BASE_URL;
		else process.env.APIFY_UPSTREAM_API_BASE_URL = previousUpstreamUrl;
		await server.close();
	});

	async function call(
		method: 'get' | 'post' | 'put' | 'delete',
		path: string,
		options: { body?: unknown; token?: string | null; contentType?: string } = {},
	) {
		const token = options.token === undefined ? server.token : options.token;
		return axios.request({
			method,
			url: `${server.baseUrl}${path}`,
			data: options.body,
			headers: {
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				...(options.contentType ? { 'Content-Type': options.contentType } : {}),
			},
			validateStatus: () => true,
		});
	}

	async function seedActor(name = `last-run-actor-${generateId()}`) {
		return server.client.actors().create({ name });
	}

	describe('the pick', () => {
		it('GET runs/last is the newest run by startedAt - the same object GET actor-runs/:runId returns', async () => {
			const actor = await seedActor();
			// Out of time order on purpose: registry order must not decide the pick.
			await seedRun(actor, { startedAt: T1 });
			const newest = await seedRun(actor, { startedAt: T3 });
			await seedRun(actor, { startedAt: T2 });

			const shortcut = await call('get', `/v2/actors/${actor.id}/runs/last`);
			expect(shortcut.status).toBe(200);
			expect(shortcut.data.data.id).toBe(newest.id);

			const direct = await call('get', `/v2/actor-runs/${newest.id}`);
			expect(shortcut.data).toEqual(direct.data);
		});

		it('resolves the Actor by id, plain name and username~name alike', async () => {
			const actor = await seedActor('named-for-last-run');
			const run = await seedRun(actor, { startedAt: T1 });
			const { username } = await server.client.user('me').get();

			for (const ref of [actor.id, 'named-for-last-run', `${username}~named-for-last-run`]) {
				const res = await call('get', `/v2/actors/${ref}/runs/last`);
				expect(res.status, ref).toBe(200);
				expect(res.data.data.id, ref).toBe(run.id);
			}
		});

		it('?status= narrows the pick to the newest run in that status', async () => {
			const actor = await seedActor();
			const olderSucceeded = await seedRun(actor, { startedAt: T1, status: 'SUCCEEDED' });
			await seedRun(actor, { startedAt: T2, status: 'FAILED' });
			const newestFailed = await seedRun(actor, { startedAt: T3, status: 'FAILED' });

			const unfiltered = await call('get', `/v2/actors/${actor.id}/runs/last`);
			expect(unfiltered.data.data.id).toBe(newestFailed.id);

			const succeeded = await call('get', `/v2/actors/${actor.id}/runs/last?status=SUCCEEDED`);
			expect(succeeded.status).toBe(200);
			expect(succeeded.data.data.id).toBe(olderSucceeded.id);

			// A platform status this runtime never produces is a valid filter that just matches nothing.
			const timingOut = await call('get', `/v2/actors/${actor.id}/runs/last?status=TIMING-OUT`);
			expect(timingOut.status).toBe(404);
			expect(timingOut.data.error.type).toBe('record-not-found');
		});

		it('?origin= narrows the pick by meta.origin', async () => {
			const actor = await seedActor();
			const fromApi = await seedRun(actor, { startedAt: T1, origin: 'API' });
			const fromCli = await seedRun(actor, { startedAt: T2, origin: 'CLI' });

			const cli = await call('get', `/v2/actors/${actor.id}/runs/last?origin=CLI`);
			expect(cli.data.data.id).toBe(fromCli.id);
			const api = await call('get', `/v2/actors/${actor.id}/runs/last?origin=API`);
			expect(api.data.data.id).toBe(fromApi.id);

			const web = await call('get', `/v2/actors/${actor.id}/runs/last?origin=WEB`);
			expect(web.status).toBe(404);
			expect(web.data.error.type).toBe('record-not-found');
		});

		it('an invalid ?status= or ?origin= is 400 invalid-request with the platform message - a repeated one too', async () => {
			const actor = await seedActor();
			await seedRun(actor, { startedAt: T1 });

			const badStatus = await call('get', `/v2/actors/${actor.id}/runs/last?status=succeeded`);
			expect(badStatus.status).toBe(400);
			expect(badStatus.data.error).toEqual({
				type: 'invalid-request',
				message: 'Status parameter has an invalid value',
			});

			const badOrigin = await call('get', `/v2/actors/${actor.id}/runs/last/dataset/items?origin=NOPE`);
			expect(badOrigin.status).toBe(400);
			expect(badOrigin.data.error).toEqual({
				type: 'invalid-request',
				message: 'Origin parameter has an invalid value',
			});

			const repeated = await call('get', `/v2/actors/${actor.id}/runs/last?status=SUCCEEDED&status=FAILED`);
			expect(repeated.status).toBe(400);
			expect(repeated.data.error.type).toBe('invalid-request');
		});

		it("works through apify-client's actor.lastRun({ status })", async () => {
			const actor = await seedActor();
			const succeeded = await seedRun(actor, { startedAt: T1, status: 'SUCCEEDED' });
			const failed = await seedRun(actor, { startedAt: T2, status: 'FAILED' });

			const last = await server.client.actor(actor.id).lastRun().get();
			expect(last?.id).toBe(failed.id);
			const lastSucceeded = await server.client.actor(actor.id).lastRun({ status: 'SUCCEEDED' }).get();
			expect(lastSucceeded?.id).toBe(succeeded.id);
		});

		it("is scoped to the caller: another user's token sees neither the Actor nor its runs", async () => {
			const actor = await seedActor('mine-only');
			await seedRun(actor, { startedAt: T1 });

			const otherToken = 'last-run-other-user-token';
			const asOther = await call('get', `/v2/actors/${actor.id}/runs/last`, { token: otherToken });
			expect(asOther.status).toBe(404);
			expect(asOther.data.error.type).toBe('record-not-found');

			// Their own same-named Actor resolves to theirs, and the first user's run is never a candidate.
			const other = new ApifyClient({ baseUrl: server.baseUrl, token: otherToken, maxRetries: 0 });
			await other.actors().create({ name: 'mine-only' });
			const byName = await call('get', '/v2/actors/mine-only/runs/last', { token: otherToken });
			expect(byName.status).toBe(404);
			expect(byName.data.error).toEqual({ type: 'record-not-found', message: 'Actor run was not found' });
		});

		it('is 401 without a token, like every /v2 route', async () => {
			const res = await call('get', '/v2/actors/whatever/runs/last', { token: null });
			expect(res.status).toBe(401);
			expect(res.data.error.type).toBe('user-not-authenticated');
		});
	});

	describe('sub-path re-dispatch onto the newest run', () => {
		it('dataset: the bare-array items contract, the dataset object, and POST items - all on the newest run', async () => {
			const actor = await seedActor();
			const older = await seedRun(actor, { startedAt: T1 });
			const newest = await seedRun(actor, { startedAt: T2 });
			await server.client.dataset(older.defaultDatasetId).pushItems([{ from: 'older' }]);
			await server.client.dataset(newest.defaultDatasetId).pushItems([{ from: 'newest', n: 1 }]);

			const items = await call('get', `/v2/actors/${actor.id}/runs/last/dataset/items?clean=true`);
			expect(items.status).toBe(200);
			expect(items.data).toEqual([{ from: 'newest', n: 1 }]);
			expect(items.headers['x-apify-pagination-total']).toBe('1');

			const info = await call('get', `/v2/actors/${actor.id}/runs/last/dataset`);
			expect(info.data.data.id).toBe(newest.defaultDatasetId);

			const pushed = await call('post', `/v2/actors/${actor.id}/runs/last/dataset/items`, {
				body: [{ from: 'shortcut' }],
				contentType: 'application/json',
			});
			expect(pushed.status).toBe(201);
			const direct = await server.client.dataset(newest.defaultDatasetId).listItems();
			expect(direct.items).toEqual([{ from: 'newest', n: 1 }, { from: 'shortcut' }]);

			// The real client's own last-run dataset path, filter included.
			const viaClient = await server.client
				.actor(actor.id)
				.lastRun({ status: 'SUCCEEDED' })
				.dataset()
				.listItems();
			expect(viaClient.items).toHaveLength(2);
		});

		it('key-value store: PUT/GET/keys/DELETE on a record, percent-encoded key forwarded byte for byte', async () => {
			const actor = await seedActor();
			const run = await seedRun(actor, { startedAt: T1 });
			const base = `/v2/actors/${actor.id}/runs/last/key-value-store`;

			const put = await call('put', `${base}/records/OUTPUT`, {
				body: { done: true },
				contentType: 'application/json',
			});
			expect(put.status).toBe(201);
			// `!()` are legal key characters; percent-encoded, they must be decoded exactly once, at the target.
			const putEncoded = await call('put', `${base}/records/OUTPUT%21%28v1%29`, {
				body: 'plain',
				contentType: 'text/plain',
			});
			expect(putEncoded.status).toBe(201);

			const direct = await server.client.keyValueStore(run.defaultKeyValueStoreId).getRecord('OUTPUT');
			expect(direct?.value).toEqual({ done: true });
			const encodedDirect = await server.client
				.keyValueStore(run.defaultKeyValueStoreId)
				.getRecord('OUTPUT!(v1)');
			expect(encodedDirect?.value).toBe('plain');

			const viaClient = await server.client.actor(actor.id).lastRun().keyValueStore().getRecord('OUTPUT');
			expect(viaClient?.value).toEqual({ done: true });

			const keys = await call('get', `${base}/keys`);
			expect(keys.data.data.items.map((k: { key: string }) => k.key).sort()).toEqual(['OUTPUT', 'OUTPUT!(v1)']);

			const store = await call('get', base);
			expect(store.data.data.id).toBe(run.defaultKeyValueStoreId);

			const deleted = await call('delete', `${base}/records/OUTPUT`);
			expect(deleted.status).toBe(204);
			const gone = await call('get', `${base}/records/OUTPUT`);
			expect(gone.status).toBe(404);
			expect(gone.data.error.type).toBe('record-not-found');
		});

		it('request queue: add a request and read the queue back', async () => {
			const actor = await seedActor();
			const run = await seedRun(actor, { startedAt: T1 });

			await server.client
				.actor(actor.id)
				.lastRun()
				.requestQueue()
				.addRequest({ url: 'http://example.com/1', uniqueKey: '1' });
			const added = await call('post', `/v2/actors/${actor.id}/runs/last/request-queue/requests`, {
				body: { url: 'http://example.com/2', uniqueKey: '2' },
				contentType: 'application/json',
			});
			expect(added.status).toBe(201);

			const queue = await call('get', `/v2/actors/${actor.id}/runs/last/request-queue`);
			expect(queue.data.data.id).toBe(run.defaultRequestQueueId);
			expect(queue.data.data.totalRequestCount).toBe(2);
			const direct = await server.client.requestQueue(run.defaultRequestQueueId).get();
			expect(direct?.totalRequestCount).toBe(2);
		});

		it('log: plain text, identical to GET logs/:runId, and readable through apify-client', async () => {
			const actor = await seedActor();
			await seedRun(actor, { startedAt: T1 });
			const newest = await seedRun(actor, { startedAt: T2 });
			appendLog(newest.id, 'hello from the newest run\n');
			await flushLog(newest.id);

			const log = await call('get', `/v2/actors/${actor.id}/runs/last/log`);
			expect(log.status).toBe(200);
			expect(log.headers['content-type']).toMatch(/^text\/plain/);
			expect(log.data).toContain('hello from the newest run');
			const direct = await call('get', `/v2/logs/${newest.id}`);
			expect(log.data).toBe(direct.data);

			const viaClient = await server.client.actor(actor.id).lastRun().log().get();
			expect(viaClient).toBe(direct.data);
		});

		it('abort: POST runs/last/abort aborts the newest run through the run route', async () => {
			const actor = await seedActor();
			await seedRun(actor, { startedAt: T1, status: 'SUCCEEDED' });
			const running = await seedRun(actor, { startedAt: T2, status: 'RUNNING' });

			const aborted = await server.client.actor(actor.id).lastRun().abort();
			expect(aborted.id).toBe(running.id);
			expect(aborted.status).toBe('ABORTED');
			expect((await getRegistries().runs.get(running.id))?.status).toBe('ABORTED');
		});

		it("reboot: POST runs/last/reboot on a finished run is the run route's own 403 job-finished", async () => {
			const actor = await seedActor();
			await seedRun(actor, { startedAt: T1, status: 'SUCCEEDED' });

			const res = await call('post', `/v2/actors/${actor.id}/runs/last/reboot`);
			expect(res.status).toBe(403);
			expect(res.data.error.type).toBe('job-finished');
		});

		it('the query string rides along to the target route, filter parameters included', async () => {
			const actor = await seedActor();
			const succeeded = await seedRun(actor, { startedAt: T1, status: 'SUCCEEDED' });
			const failed = await seedRun(actor, { startedAt: T2, status: 'FAILED' });
			await server.client.dataset(succeeded.defaultDatasetId).pushItems([{ i: 1 }, { i: 2 }, { i: 3 }]);
			await server.client.dataset(failed.defaultDatasetId).pushItems([{ failed: true }]);

			const res = await call(
				'get',
				`/v2/actors/${actor.id}/runs/last/dataset/items?status=SUCCEEDED&offset=1&limit=1`,
			);
			expect(res.status).toBe(200);
			expect(res.data).toEqual([{ i: 2 }]);
			expect(res.headers['x-apify-pagination-offset']).toBe('1');
			expect(res.headers['x-apify-pagination-total']).toBe('3');
		});
	});

	describe('the error ladder', () => {
		it('an unknown Actor is 404 record-not-found', async () => {
			const res = await call('get', '/v2/actors/no-such-actor/runs/last/dataset/items');
			expect(res.status).toBe(404);
			expect(res.data.error.type).toBe('record-not-found');
		});

		it('a known Actor with no run yet is 404 record-not-found - also ahead of an unknown sub-path, like the platform', async () => {
			const actor = await seedActor();

			const bare = await call('get', `/v2/actors/${actor.id}/runs/last`);
			expect(bare.status).toBe(404);
			expect(bare.data.error).toEqual({ type: 'record-not-found', message: 'Actor run was not found' });

			const unknownSubPath = await call('get', `/v2/actors/${actor.id}/runs/last/foo`);
			expect(unknownSubPath.status).toBe(404);
			expect(unknownSubPath.data.error.type).toBe('record-not-found');
		});

		it('a sub-path the platform has no last-run form for is 404 not-found - a real run endpoint (resurrect) included', async () => {
			const actor = await seedActor();
			await seedRun(actor, { startedAt: T1 });

			for (const suffix of ['foo', 'resurrect', 'dataset-items']) {
				const res = await call('get', `/v2/actors/${actor.id}/runs/last/${suffix}`);
				expect(res.status, suffix).toBe(404);
				expect(res.data.error.type, suffix).toBe('not-found');
			}
		});

		it('the bare form is GET-only: DELETE runs/last is 404 not-found and deletes nothing', async () => {
			const actor = await seedActor();
			const run = await seedRun(actor, { startedAt: T1 });

			const res = await call('delete', `/v2/actors/${actor.id}/runs/last`);
			expect(res.status).toBe(404);
			expect(res.data.error.type).toBe('not-found');
			expect(await getRegistries().runs.get(run.id)).not.toBeNull();

			const post = await call('post', `/v2/actors/${actor.id}/runs/last`);
			expect(post.status).toBe(404);
			expect(post.data.error.type).toBe('not-found');
		});

		it("a sub-path whose target is 501 here answers that target's 501 not-implemented", async () => {
			const actor = await seedActor();
			await seedRun(actor, { startedAt: T1 });

			const zip = await call('get', `/v2/actors/${actor.id}/runs/last/key-value-store/records`);
			expect(zip.status).toBe(501);
			expect(zip.data.error.type).toBe('not-implemented');

			const metamorph = await call('post', `/v2/actors/${actor.id}/runs/last/metamorph`);
			expect(metamorph.status).toBe(501);
			expect(metamorph.data.error.type).toBe('not-implemented');
		});
	});

	describe('source consistency with the upstream fallback', () => {
		async function withStub(test: (stub: Awaited<ReturnType<typeof startStubUpstream>>) => Promise<void>) {
			const stub = await startStubUpstream(() => ({
				status: 200,
				body: { fromUpstream: true },
				headers: { 'x-stub-marker': 'platform' },
			}));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				await test(stub);
			} finally {
				await stub.close();
			}
		}

		function expectLocalAnswer(res: { headers: Record<string, unknown> }) {
			expect(res.headers['x-actor-runtime-fallback']).toBeUndefined();
			expect(res.headers['x-actor-runtime-fallback-trigger']).toBeUndefined();
		}

		it('both toggles on: a local Actor with no run yet is answered locally, the platform is never asked', async () => {
			setApiFallbackState({ fallbackUnimplementedEnabled: true, fallbackNotFoundEnabled: true });
			const actor = await seedActor();

			await withStub(async (stub) => {
				const res = await call('get', `/v2/actors/${actor.id}/runs/last/dataset/items`);
				expect(res.status).toBe(404);
				expect(res.data.error.type).toBe('record-not-found');
				expectLocalAnswer(res);
				expect(stub.hitCount()).toBe(0);
			});
		});

		it("both toggles on: a local Actor's later misses of every eligible type stay local", async () => {
			setApiFallbackState({ fallbackUnimplementedEnabled: true, fallbackNotFoundEnabled: true });
			const actor = await seedActor();
			await seedRun(actor, { startedAt: T1 });
			const base = `/v2/actors/${actor.id}/runs/last`;

			await withStub(async (stub) => {
				// `record-not-found` from the target route.
				const missingKey = await call('get', `${base}/key-value-store/records/NOPE`);
				expect(missingKey.status).toBe(404);
				expect(missingKey.data.error.type).toBe('record-not-found');
				expectLocalAnswer(missingKey);

				// `not-found` decided by the last-run route itself.
				const unknownSubPath = await call('get', `${base}/foo`);
				expect(unknownSubPath.status).toBe(404);
				expect(unknownSubPath.data.error.type).toBe('not-found');
				expectLocalAnswer(unknownSubPath);

				// `not-implemented` from the catch-all.
				const zip = await call('get', `${base}/key-value-store/records`);
				expect(zip.status).toBe(501);
				expectLocalAnswer(zip);
				const metamorph = await call('post', `${base}/metamorph`);
				expect(metamorph.status).toBe(501);
				expectLocalAnswer(metamorph);

				// A filter matching no local run is still a local "no run", never the platform's last run.
				const noneInStatus = await call('get', `${base}?status=TIMING-OUT`);
				expect(noneInStatus.status).toBe(404);
				expect(noneInStatus.data.error.type).toBe('record-not-found');
				expectLocalAnswer(noneInStatus);

				expect(stub.hitCount()).toBe(0);
			});
		});

		it('fallbackNotFoundEnabled: an unknown Actor relays the whole original request once, URL and query intact, own token only', async () => {
			setApiFallbackState({ fallbackUnimplementedEnabled: false, fallbackNotFoundEnabled: true });
			// A local Actor with a run exists too, and must play no part in a request naming another Actor.
			const local = await seedActor('local-bystander');
			await seedRun(local, { startedAt: T1 });

			await withStub(async (stub) => {
				const path = '/v2/actors/someone~platform-only/runs/last/dataset/items?status=SUCCEEDED&clean=true';
				const res = await call('get', path);
				expect(res.status).toBe(200);
				expect(res.data).toEqual({ fromUpstream: true });
				expect(res.headers['x-stub-marker']).toBe('platform');
				expect(res.headers['x-actor-runtime-fallback']).toBe(stub.baseUrl);
				expect(res.headers['x-actor-runtime-fallback-trigger']).toBe('record-not-found');

				expect(stub.hitCount()).toBe(1);
				const relayed = stub.requests()[0]!;
				expect(relayed.method).toBe('GET');
				// The caller's URL, never a rewritten local one.
				expect(relayed.url).toBe(path);
				expect(relayed.headers.authorization).toBe(`Bearer ${server.token}`);
			});
		});

		it('fallbackNotFoundEnabled: a write shortcut on an unknown Actor relays as the same write, whole', async () => {
			setApiFallbackState({ fallbackUnimplementedEnabled: false, fallbackNotFoundEnabled: true });

			await withStub(async (stub) => {
				const path = '/v2/actors/platform-only/runs/last/abort?gracefully=true';
				const res = await call('post', path);
				expect(res.status).toBe(200);
				expect(res.headers['x-actor-runtime-fallback-trigger']).toBe('record-not-found');
				expect(stub.hitCount()).toBe(1);
				expect(stub.requests()[0]?.method).toBe('POST');
				expect(stub.requests()[0]?.url).toBe(path);
			});
		});

		it('fallbackUnimplementedEnabled alone: an unknown Actor is a record-not-found miss and stays local', async () => {
			setApiFallbackState({ fallbackUnimplementedEnabled: true, fallbackNotFoundEnabled: false });

			await withStub(async (stub) => {
				const res = await call('get', '/v2/actors/platform-only/runs/last');
				expect(res.status).toBe(404);
				expect(res.data.error.type).toBe('record-not-found');
				expectLocalAnswer(res);
				expect(stub.hitCount()).toBe(0);
			});
		});

		it('an invalid filter on an unknown Actor is 400 locally, never relayed', async () => {
			setApiFallbackState({ fallbackUnimplementedEnabled: true, fallbackNotFoundEnabled: true });

			await withStub(async (stub) => {
				const res = await call('get', '/v2/actors/platform-only/runs/last?status=nope');
				expect(res.status).toBe(400);
				expect(res.data.error.type).toBe('invalid-request');
				expect(stub.hitCount()).toBe(0);
			});
		});

		it('fail-closed: a platform that does not know the Actor either leaves the original local 404 in place', async () => {
			setApiFallbackState({ fallbackUnimplementedEnabled: false, fallbackNotFoundEnabled: true });
			const stub = await startStubUpstream(() => ({
				status: 404,
				body: { error: { type: 'record-not-found', message: 'nope' } },
			}));
			process.env.APIFY_UPSTREAM_API_BASE_URL = stub.baseUrl;
			try {
				const res = await call('get', '/v2/actors/nobody-has-this/runs/last/log');
				expect(res.status).toBe(404);
				expect(res.data.error.type).toBe('record-not-found');
				expectLocalAnswer(res);
				expect(stub.hitCount()).toBe(1);
			} finally {
				await stub.close();
			}
		});
	});
});
