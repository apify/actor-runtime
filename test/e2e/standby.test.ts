/**
 * Actor Standby end to end (`test.md`'s "Actor Standby"), for both standby samples: `apify push` enables
 * Standby from `.actor/actor.json`, requests to the Actor's standby URL are served by one standby run,
 * an idle run is wound down, and the next request starts a fresh one that sees the previous run's
 * totals. The requests themselves are plain HTTP and a websocket - the narrow exception `test.md`
 * allows, since no `apify` command sends one; every other assertion reads `apify` output.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
	buildRuntimeImage,
	isDockerAvailable,
	pullBaseImages,
	startRuntimeContainer,
	stopRuntimeContainer,
	waitForHttpOk,
} from './helpers/docker.js';
import {
	apify,
	apifyEnv,
	createIsolatedApifyHome,
	loginApifyCli,
	removeIsolatedApifyHome,
	type ApiEnvelope,
	type DatasetInfoResult,
	type PushResult,
} from './helpers/apify-cli.js';
import { waitFor } from './helpers/wait.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CONTAINER_NAME = 'actor-runtime-e2e-standby';
const IMAGE_TAG = 'actor-runtime:e2e';
/** `helpers/apify-cli.ts`' login token. */
const TOKEN = 'anything';

interface RunSummary {
	id: string;
	status: string;
	meta: { origin: string };
	defaultDatasetId: string;
	options: { timeoutSecs: number };
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...init?.headers } });
	expect(res.status, `${url} answered ${res.status}: ${await res.clone().text()}`).toBe(200);
	return (await res.json()) as T;
}

function websocketRoundTrip(url: string): Promise<string[]> {
	return new Promise((resolve, reject) => {
		const frames: string[] = [];
		const socket = new WebSocket(url);
		socket.on('message', (data) => {
			frames.push(String(data));
			if (frames.length === 1) socket.send('ping');
			else socket.close();
		});
		socket.on('close', () => resolve(frames));
		socket.on('error', reject);
	});
}

describe('Actor Standby via apify-cli (requires Docker)', () => {
	let isolatedApifyHome: string;

	beforeAll(
		async () => {
			if (!isDockerAvailable()) {
				throw new Error(
					'Docker daemon is not reachable - the e2e suite requires one (see requirements/test.md)',
				);
			}
			pullBaseImages();
			buildRuntimeImage(REPO_ROOT, IMAGE_TAG);
			startRuntimeContainer(IMAGE_TAG, CONTAINER_NAME);
			await waitForHttpOk('http://localhost:3333/v2/users/me?token=x');
			isolatedApifyHome = createIsolatedApifyHome();
			loginApifyCli(REPO_ROOT, isolatedApifyHome);
		},
		10 * 60 * 1000,
	);

	afterAll(() => {
		stopRuntimeContainer(CONTAINER_NAME);
		if (isolatedApifyHome) removeIsolatedApifyHome(isolatedApifyHome);
	});

	for (const sample of ['sample_actor_standby_ts', 'sample_actor_standby_py']) {
		it(
			`${sample}: push enables Standby; one STANDBY run serves every endpoint and is wound down once idle`,
			async () => {
				const actorDir = join(REPO_ROOT, sample);
				const env = apifyEnv(isolatedApifyHome);
				const push = JSON.parse(apify(['push', '--json'], { cwd: actorDir, env })) as PushResult;
				expect(push.build.status).toBe('SUCCEEDED');

				const actorId = push.actor.id;
				const body = JSON.stringify({ actorStandby: { idleTimeoutSecs: 10 } });
				apify(['api', 'PUT', `actors/${actorId}`, '--body', body], { cwd: actorDir, env });
				const actor = JSON.parse(
					apify(['api', 'GET', `actors/${actorId}`], { cwd: actorDir, env }),
				) as ApiEnvelope<{ actorStandby: { isEnabled: boolean; idleTimeoutSecs: number }; standbyUrl: string }>;
				expect(actor.data.actorStandby).toMatchObject({ isEnabled: true, idleTimeoutSecs: 10 });
				const url = actor.data.standbyUrl;

				const index = await getJson<{ runId: string; endpoints: string[] }>(`${url}/`);
				expect(index.endpoints).toContain('GET /hello?name=');
				const runId = index.runId;

				for (const name of ['Ada', 'Grace', 'Linus']) {
					const hello = await getJson<{ greeting: string; runId: string }>(`${url}/hello?name=${name}`);
					expect(hello).toMatchObject({ greeting: `Hello, ${name}!`, runId });
				}

				const echo = await getJson<{ query: Record<string, string>; body: unknown }>(`${url}/echo?x=1`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ nested: { ok: true } }),
				});
				expect(echo).toMatchObject({ query: { x: '1' }, body: { nested: { ok: true } } });

				const stream = await fetch(`${url}/stream?count=3&token=${TOKEN}`);
				expect(stream.headers.get('content-type')).toMatch(/^text\/event-stream/);
				const events = (await stream.text()).match(/^event: \w+$/gm);
				expect(events).toEqual(['event: tick', 'event: tick', 'event: tick', 'event: done']);

				const frames = await websocketRoundTrip(`${url.replace(/^http/, 'ws')}/ws?token=${TOKEN}`);
				expect(JSON.parse(frames[0]!)).toMatchObject({ runId });
				expect(JSON.parse(frames[1]!)).toEqual({ echo: 'ping' });

				const runOf = () =>
					(
						JSON.parse(
							apify(['api', 'GET', `actor-runs/${runId}`], { cwd: actorDir, env }),
						) as ApiEnvelope<RunSummary>
					).data;
				expect(runOf()).toMatchObject({
					status: 'RUNNING',
					meta: { origin: 'STANDBY' },
					options: { timeoutSecs: 0 },
				});

				const finished = await waitFor(
					() => {
						const run = runOf();
						return run.status === 'SUCCEEDED' ? run : undefined;
					},
					120_000,
					'the idle standby run to finish',
				);
				const info = JSON.parse(
					apify(['datasets', 'info', finished.defaultDatasetId, '--json'], { cwd: actorDir, env }),
				) as DatasetInfoResult;
				expect(info.itemCount).toBe(3);
				const log = apify(['api', 'GET', `logs/${runId}`], { cwd: actorDir, env });
				expect(log).toContain('Actor Standby server was idle for too long, finishing run.');

				// A fresh run, which reads the totals the finished one saved: 3 greetings, an echo, a stream,
				// a websocket, and now this request.
				const stats = await getJson<{ runId: string; allRuns: { served: number; runs: number } }>(
					`${url}/stats`,
				);
				expect(stats.runId).not.toBe(runId);
				expect(stats.allRuns).toEqual({ served: 7, runs: 2 });
			},
			8 * 60 * 1000,
		);
	}
});
