/**
 * Pay-per-event pricing and the run cost estimate through stock `apify-cli` only (`test.md`), against a
 * real Docker daemon: price the TypeScript sample Actor, run it, and read the charges and the estimate
 * back off the run object; then cap a run's spend and watch the runtime stop it (`actor-driver.md`'s
 * "Pay-per-event pricing" and "Run usage estimate" sections).
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	buildRuntimeImage,
	isDockerAvailable,
	pullImage,
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
	type CallResult,
	type PushResult,
} from './helpers/apify-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SAMPLE_ACTOR_DIR = join(REPO_ROOT, 'sample_actor_ts');
const CONTAINER_NAME = 'actor-runtime-e2e-pay-per-event';
const IMAGE_TAG = 'actor-runtime:e2e-pay-per-event';
/** `sample_actor_ts/Dockerfile`'s base image. */
const SAMPLE_BASE_IMAGE = 'apify/actor-node:24';

/** The event `sample_actor_ts` charges once per page, priced so a handful of pages is cheap. */
const PAGE_EVENT = 'page-scraped';
const PAGE_PRICE_USD = 0.01;
const START_PRICE_USD = 0.005;
const PRICING = [
	{
		pricingModel: 'PAY_PER_EVENT',
		pricingPerEvent: {
			actorChargeEvents: {
				[PAGE_EVENT]: { eventTitle: 'Page scraped', eventPriceUsd: PAGE_PRICE_USD },
				'apify-actor-start': {
					eventTitle: 'Actor start',
					eventPriceUsd: START_PRICE_USD,
					isOneTimeEvent: true,
				},
			},
		},
	},
];

interface RunObject {
	id: string;
	status: string;
	statusMessage?: string;
	options: { memoryMbytes: number; maxTotalChargeUsd?: number };
	stats: { computeUnits: number; runTimeSecs: number; memAvgBytes?: number };
	usage: { ACTOR_COMPUTE_UNITS: number };
	usageUsd: { ACTOR_COMPUTE_UNITS: number };
	usageTotalUsd: number;
	pricingInfo?: { pricingModel: string };
	chargedEventCounts?: Record<string, number>;
	eventUsage?: Record<string, { eventTitle: string; eventTotalUsd: number }>;
	chargingStoppedAt?: string;
}

function getRun(runId: string, env: NodeJS.ProcessEnv): RunObject {
	return (JSON.parse(apify(['api', 'GET', `actor-runs/${runId}`], { cwd: REPO_ROOT, env })) as ApiEnvelope<RunObject>)
		.data;
}

function storedLog(runId: string, env: NodeJS.ProcessEnv): string {
	return apify(['api', 'GET', `actor-runs/${runId}/log`], { cwd: REPO_ROOT, env });
}

describe('pay-per-event pricing and the run cost estimate via apify-cli (requires Docker)', () => {
	let isolatedApifyHome: string;
	let actorId: string;

	beforeAll(
		async () => {
			if (!isDockerAvailable()) {
				throw new Error(
					'Docker daemon is not reachable - this e2e case requires one (see requirements/test.md)',
				);
			}
			pullImage(SAMPLE_BASE_IMAGE);
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
		'push, price the Actor through PUT /v2/actors/:id, call it: the run charges one event per page, the start event is pre-charged, and the run object prices everything',
		() => {
			const env = apifyEnv(isolatedApifyHome);

			const push = JSON.parse(apify(['push', '--json'], { cwd: SAMPLE_ACTOR_DIR, env })) as PushResult;
			expect(push.build.status).toBe('SUCCEEDED');
			actorId = push.actor.id;

			// A free run first: no pricing fields at all, but the compute-unit estimate is there.
			const freeCall = JSON.parse(
				apify(['call', '--input', JSON.stringify({ maxPages: 2 }), '--json'], { cwd: SAMPLE_ACTOR_DIR, env }),
			) as CallResult;
			expect(freeCall.run.status).toBe('SUCCEEDED');
			const freeRun = getRun(freeCall.run.id, env);
			expect(freeRun.pricingInfo).toBeUndefined();
			expect(freeRun.chargedEventCounts).toBeUndefined();
			expect(freeRun.stats.computeUnits).toBeGreaterThan(0);
			expect(freeRun.usageUsd.ACTOR_COMPUTE_UNITS).toBeCloseTo(freeRun.usage.ACTOR_COMPUTE_UNITS * 0.2, 6);
			expect(freeRun.usageTotalUsd).toBe(freeRun.usageUsd.ACTOR_COMPUTE_UNITS);
			// The container was sampled while it ran.
			expect(freeRun.stats.memAvgBytes).toBeGreaterThan(0);
			expect(storedLog(freeCall.run.id, env)).not.toContain('Pay-per-event pricing in effect');

			const priced = JSON.parse(
				apify(['api', 'PUT', `/v2/actors/${actorId}`, '--body', JSON.stringify({ pricingInfos: PRICING })], {
					cwd: REPO_ROOT,
					env,
				}),
			) as ApiEnvelope<{ pricingInfos: unknown[] }>;
			expect(priced.data.pricingInfos).toHaveLength(1);

			const call = JSON.parse(
				apify(['call', '--input', JSON.stringify({ maxPages: 3 }), '--json'], { cwd: SAMPLE_ACTOR_DIR, env }),
			) as CallResult;
			expect(call.run.status).toBe('SUCCEEDED');
			const run = getRun(call.run.id, env);
			expect(run.pricingInfo?.pricingModel).toBe('PAY_PER_EVENT');
			// 1024 MB -> the start event once; the SDK charged one page event per page over the charge endpoint.
			expect(run.chargedEventCounts).toEqual({ [PAGE_EVENT]: 3, 'apify-actor-start': 1 });
			expect(run.eventUsage?.[PAGE_EVENT]).toEqual({ eventTitle: 'Page scraped', eventTotalUsd: 0.03 });
			expect(run.eventUsage?.['apify-actor-start']).toEqual({ eventTitle: 'Actor start', eventTotalUsd: 0.005 });
			expect(run.usageTotalUsd).toBeCloseTo(0.035 + run.usageUsd.ACTOR_COMPUTE_UNITS, 6);
			expect(run.options.maxTotalChargeUsd).toBeUndefined();

			const log = storedLog(call.run.id, env);
			expect(log).toContain('Pay-per-event pricing in effect, max total charge: none.');
			expect(log.match(/Charged 1 'page-scraped' event\(s\); limit reached: false\./g)).toHaveLength(3);
		},
		5 * 60 * 1000,
	);

	it(
		'a run started with maxTotalChargeUsd stops at the cap: the SDK reports the limit, the runtime aborts the run gracefully with the reason, and the cap is on the run object',
		() => {
			const env = apifyEnv(isolatedApifyHome);
			// $0.005 start + 2 pages ($0.02) = $0.025 < $0.03; the third page crosses the cap.
			const started = JSON.parse(
				apify(
					[
						'api',
						'POST',
						`/v2/actors/${actorId}/runs?maxTotalChargeUsd=0.03&waitForFinish=120`,
						'--body',
						JSON.stringify({ maxPages: 10 }),
					],
					{ cwd: REPO_ROOT, env },
				),
			) as ApiEnvelope<RunObject>;
			const run = getRun(started.data.id, env);
			expect(run.options.maxTotalChargeUsd).toBe(0.03);
			expect(run.status).toBe('ABORTED');
			expect(run.statusMessage).toMatch(/maximum total charge of \$0\.03 was reached/);
			expect(typeof run.chargingStoppedAt).toBe('string');
			// Three page charges landed (the SDK overshoots by one at the cap, exactly like on the platform).
			expect(run.chargedEventCounts?.[PAGE_EVENT]).toBe(3);
			expect(run.chargedEventCounts?.['apify-actor-start']).toBe(1);

			const log = storedLog(run.id, env);
			expect(log).toContain('Pay-per-event pricing in effect, max total charge: $0.03.');
			expect(log).toContain("Charged 1 'page-scraped' event(s); limit reached: true.");
			expect(log).toContain('maximum total charge of $0.03 was reached');
		},
		5 * 60 * 1000,
	);
});
