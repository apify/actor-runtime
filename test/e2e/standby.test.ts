/**
 * Actor Standby end to end (`test.md`'s "Actor Standby"): `apify push` of `sample_actor_standby` enables
 * Standby from its `.actor/actor.json`, requests to the Actor's standby URL are served by a standby run,
 * and an idle run is wound down. The requests themselves are plain HTTP - the narrow exception `test.md`
 * allows, since no `apify` command sends one; every other assertion reads `apify` output.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
const ACTOR_DIR = join(REPO_ROOT, 'sample_actor_standby');
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

	it(
		'push enables Standby; requests share one STANDBY run, which is wound down SUCCEEDED once idle',
		async () => {
			const env = apifyEnv(isolatedApifyHome);
			const push = JSON.parse(apify(['push', '--json'], { cwd: ACTOR_DIR, env })) as PushResult;
			expect(push.build.status).toBe('SUCCEEDED');

			const actorId = push.actor.id;
			apify(
				[
					'api',
					'PUT',
					`actors/${actorId}`,
					'--body',
					JSON.stringify({ actorStandby: { idleTimeoutSecs: 10 } }),
				],
				{
					cwd: ACTOR_DIR,
					env,
				},
			);
			const actor = JSON.parse(
				apify(['api', 'GET', `actors/${actorId}`], { cwd: ACTOR_DIR, env }),
			) as ApiEnvelope<{
				actorStandby: { isEnabled: boolean; idleTimeoutSecs: number };
				standbyUrl: string;
			}>;
			expect(actor.data.actorStandby).toMatchObject({ isEnabled: true, idleTimeoutSecs: 10 });

			const greetings: Array<{ greeting: string; runId: string }> = [];
			for (const name of ['Ada', 'Grace', 'Linus']) {
				const res = await fetch(`${actor.data.standbyUrl}/hello?name=${name}`, {
					headers: { authorization: `Bearer ${TOKEN}` },
				});
				expect(res.status).toBe(200);
				greetings.push((await res.json()) as { greeting: string; runId: string });
			}
			expect(greetings.map((g) => g.greeting)).toEqual(['Hello, Ada!', 'Hello, Grace!', 'Hello, Linus!']);
			expect(new Set(greetings.map((g) => g.runId)).size).toBe(1);
			const runId = greetings[0]!.runId;

			const runOf = () =>
				(
					JSON.parse(
						apify(['api', 'GET', `actor-runs/${runId}`], { cwd: ACTOR_DIR, env }),
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
				90_000,
				'the idle standby run to finish',
			);
			const info = JSON.parse(
				apify(['datasets', 'info', finished.defaultDatasetId, '--json'], { cwd: ACTOR_DIR, env }),
			) as DatasetInfoResult;
			expect(info.itemCount).toBe(3);
			const log = apify(['api', 'GET', `logs/${runId}`], { cwd: ACTOR_DIR, env });
			expect(log).toContain('Actor Standby server was idle for too long, finishing run.');

			// The next request starts a fresh run.
			const next = (await (await fetch(`${actor.data.standbyUrl}/?token=${TOKEN}`)).json()) as { runId: string };
			expect(next.runId).not.toBe(runId);
		},
		5 * 60 * 1000,
	);
});
