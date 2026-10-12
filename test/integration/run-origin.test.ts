/**
 * A run's `meta.origin` comes from the caller's `X-Apify-Request-Origin` (`api.md`'s "Actor run origin"),
 * as on the platform: the Apify CLI's runs are `CLI`, a webhook-started one `WEBHOOK`, anything else `API`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';

import { capturingDriver, startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import { generateId } from '../../src/storage/ids.js';
import { getRegistries } from '../../src/storage/registries.js';

describe('run origin (X-Apify-Request-Origin)', () => {
	let server: TestServerHandle;
	let capturedEnv: () => Record<string, string> | undefined;
	let actorId: string;

	beforeEach(async () => {
		const capturing = capturingDriver();
		capturedEnv = () => capturing.captured.runEnv;
		server = await startTestServer(capturing.driver);
		const actor = await server.client.actors().create({ name: 'origin-actor' });
		actorId = actor.id;
		const buildId = generateId();
		await getRegistries().builds.set(buildId, {
			id: buildId,
			userId: actor.userId,
			actorId,
			versionNumber: '0.0',
			buildNumber: '0.0.1',
			tag: 'latest',
			status: 'SUCCEEDED',
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			imageId: 'fake-image:latest',
		});
		await updateActor(actorId, (current) => recordTaggedBuild(current, 'latest', buildId, '0.0.1'));
	});

	afterEach(async () => {
		await server.close();
	});

	async function post(path: string, origin?: string) {
		const res = await axios.post(`${server.baseUrl}/v2/${path}`, '{}', {
			headers: {
				Authorization: `Bearer ${server.token}`,
				'Content-Type': 'application/json',
				...(origin === undefined ? {} : { 'X-Apify-Request-Origin': origin }),
			},
			validateStatus: () => true,
		});
		expect(res.status).toBe(201);
		return res;
	}

	async function startRun(path: string, origin?: string) {
		const run = (await post(path, origin)).data.data as { id: string; meta: { origin: string } };
		await server.client.run(run.id).waitForFinish({ waitSecs: 5 });
		return run;
	}

	it('takes the origin from the header, for Actor, run-sync and task runs alike', async () => {
		const cli = await startRun(`actors/${actorId}/runs`, 'CLI');
		expect(cli.meta).toEqual({ origin: 'CLI' });
		expect(capturedEnv()!.APIFY_META_ORIGIN).toBe('CLI');
		expect((await server.client.run(cli.id).get())!.meta.origin).toBe('CLI');

		// `run-sync` answers with the run's output, so the run itself is read back through its Actor.
		await post(`actors/${actorId}/run-sync`, 'WEBHOOK');
		expect((await server.client.actor(actorId).lastRun().get())!.meta.origin).toBe('WEBHOOK');

		const task = await server.client.tasks().create({ actId: actorId, name: 'origin-task' });
		const fromTask = await startRun(`actor-tasks/${task.id}/runs`, 'WEB');
		expect(fromTask.meta.origin).toBe('WEB');
	});

	it('is API without the header, and for a value the platform does not know', async () => {
		expect((await startRun(`actors/${actorId}/runs`)).meta.origin).toBe('API');
		expect((await startRun(`actors/${actorId}/runs`, 'NOPE')).meta.origin).toBe('API');
		expect((await startRun(`actors/${actorId}/runs`, 'cli')).meta.origin).toBe('API');
	});

	it('is what the last-run shortcut filters on', async () => {
		await startRun(`actors/${actorId}/runs`, 'CLI');
		const fromApi = await startRun(`actors/${actorId}/runs`);

		const last = await server.client
			.actor(actorId)
			.lastRun({ origin: 'API' as never })
			.get();
		expect(last!.id).toBe(fromApi.id);
		const none = await axios.get(`${server.baseUrl}/v2/actors/${actorId}/runs/last?origin=WEBHOOK`, {
			headers: { Authorization: `Bearer ${server.token}` },
			validateStatus: () => true,
		});
		expect(none.status).toBe(404);
	});
});
