/**
 * `?waitForFinish=` on `GET v2/actor-runs/:runId` and `GET v2/actor-builds/:buildId` (`api.md`'s "Public
 * API"): what apify-client's `run.waitForFinish()` / `build.waitForFinish()` poll, so a `GET` that answers
 * at once would make that loop spin.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { createStorage } from '../../src/services/storages.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import type { BuildRecord, RunRecord } from '../../src/storage/entities.js';

describe('waitForFinish on GET run and GET build', () => {
	let server: TestServerHandle;

	beforeEach(async () => {
		server = await startTestServer();
	});

	afterEach(async () => {
		await server.close();
	});

	async function seedRun(): Promise<RunRecord> {
		const actor = await server.client.actors().create({ name: `wait-for-finish-${generateId()}` });
		const [dataset, keyValueStore, requestQueue] = await Promise.all([
			createStorage(actor.userId, 'dataset'),
			createStorage(actor.userId, 'keyValueStore'),
			createStorage(actor.userId, 'requestQueue'),
		]);
		const run: RunRecord = {
			id: generateId(),
			userId: actor.userId,
			actorId: actor.id,
			buildId: generateId(),
			buildNumber: '0.0.1',
			status: 'RUNNING',
			startedAt: new Date().toISOString(),
			defaultDatasetId: dataset.id,
			defaultKeyValueStoreId: keyValueStore.id,
			defaultRequestQueueId: requestQueue.id,
			options: { memoryMbytes: 1024, timeoutSecs: 300 },
			meta: { origin: 'API' },
		};
		await getRegistries().runs.set(run.id, run);
		return run;
	}

	async function seedBuild(): Promise<BuildRecord> {
		const actor = await server.client.actors().create({ name: `wait-for-build-${generateId()}` });
		const build: BuildRecord = {
			id: generateId(),
			userId: actor.userId,
			actorId: actor.id,
			versionNumber: '0.0',
			buildNumber: '0.0.1',
			tag: 'latest',
			status: 'RUNNING',
			startedAt: new Date().toISOString(),
		};
		await getRegistries().builds.set(build.id, build);
		return build;
	}

	function get(path: string) {
		return axios.get(`${server.baseUrl}${path}`, {
			headers: { Authorization: `Bearer ${server.token}` },
			validateStatus: () => true,
		});
	}

	async function finishLater<T extends { status: string }>(
		registry: { update: (id: string, fn: (current: T | undefined) => T | undefined | null) => Promise<unknown> },
		id: string,
		afterMs: number,
	): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, afterMs));
		await registry.update(id, (current) => current && { ...current, status: 'SUCCEEDED' });
	}

	it('holds GET run until the run finishes, then answers with the final record', async () => {
		const run = await seedRun();
		const started = Date.now();
		const [response] = await Promise.all([
			get(`/v2/actor-runs/${run.id}?waitForFinish=10`),
			finishLater(getRegistries().runs, run.id, 500),
		]);
		expect(response.status).toBe(200);
		expect(response.data.data.status).toBe('SUCCEEDED');
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(450);
		expect(elapsed).toBeLessThan(5000);
	});

	it('gives up after the given seconds with the run still running, and answers at once without the parameter', async () => {
		const run = await seedRun();
		const started = Date.now();
		const held = await get(`/v2/actor-runs/${run.id}?waitForFinish=1`);
		expect(held.data.data.status).toBe('RUNNING');
		expect(Date.now() - started).toBeGreaterThanOrEqual(950);

		const immediate = Date.now();
		const plain = await get(`/v2/actor-runs/${run.id}`);
		expect(plain.data.data.status).toBe('RUNNING');
		expect(Date.now() - immediate).toBeLessThan(500);
	});

	it('is honoured through the runs/last shortcut too', async () => {
		const run = await seedRun();
		const [response] = await Promise.all([
			get(`/v2/actors/${run.actorId}/runs/last?waitForFinish=10`),
			finishLater(getRegistries().runs, run.id, 300),
		]);
		expect(response.status).toBe(200);
		expect(response.data.data).toMatchObject({ id: run.id, status: 'SUCCEEDED' });
	});

	it('holds GET build the same way', async () => {
		const build = await seedBuild();
		const [response] = await Promise.all([
			get(`/v2/actor-builds/${build.id}?waitForFinish=10`),
			finishLater(getRegistries().builds, build.id, 300),
		]);
		expect(response.status).toBe(200);
		expect(response.data.data).toMatchObject({ id: build.id, status: 'SUCCEEDED' });
	});
});
