/**
 * E2E coverage for per-Actor browser view (`actor-driver.md`'s "Browser view" section) against a real
 * Docker daemon: each Playwright sample Actor (TypeScript and Python) is pushed, browser view is turned on, a
 * run is started, and its display mirror is reached the way the console's viewer page reaches it. Driven by `apify` commands
 * per `requirements/test.md`'s CLI-only rule, with the one narrow exception that rule documents for this
 * test: it opens the console's viewer websocket (`/runs/:id/browser/ws`) directly and reads the RFB
 * greeting off it, because the workflow under test is "a browser connects to the mirror" and no `apify`
 * command can express that.
 *
 * Like `debug-mode.test.ts`, the run is started with `apify api POST actors/<id>/runs` rather than `apify
 * call`, so the test can poll the log and probe the mirror while the run is still going.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
	buildRuntimeImage,
	isDockerAvailable,
	pullPlaywrightBaseImages,
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
	type DatasetInfoResult,
	type PushResult,
} from './helpers/apify-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CONTAINER_NAME = 'actor-runtime-e2e-browser-view';
const IMAGE_TAG = 'actor-runtime:e2e-browser-view';
const CONSOLE_URL = 'http://localhost:3000';

interface RunApi {
	id: string;
	status: string;
	statusMessage?: string;
}

function startRun(actorId: string, input: unknown, env: NodeJS.ProcessEnv): RunApi {
	const output = apify(['api', 'POST', `actors/${actorId}/runs`, '--body', JSON.stringify(input)], {
		cwd: REPO_ROOT,
		env,
	});
	return (JSON.parse(output) as ApiEnvelope<RunApi>).data;
}

function getRun(runId: string, env: NodeJS.ProcessEnv): RunApi {
	const output = apify(['api', 'GET', `actor-runs/${runId}`], { cwd: REPO_ROOT, env });
	return (JSON.parse(output) as ApiEnvelope<RunApi>).data;
}

/** Non-streaming log fetch (see `debug-mode.test.ts`'s `currentLog` for why not `apify runs log`). */
function currentLog(runId: string, env: NodeJS.ProcessEnv): string {
	return apify(['api', 'GET', `actor-runs/${runId}/log`], { cwd: REPO_ROOT, env });
}

async function waitFor<T>(
	check: () => T | undefined | Promise<T | undefined>,
	timeoutMs: number,
	description: string,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		let result: T | undefined;
		try {
			result = await check();
		} catch {
			result = undefined;
		}
		if (result !== undefined) return result;
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for: ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}

/**
 * Opens the console's viewer websocket for the run and resolves with the first bytes the mirror sends: an
 * RFB server's `ProtocolVersion` greeting (`RFB 003.008\n`), which x11vnc sends the moment a client
 * connects - proof that the bridge reached a live VNC server mirroring the run's display, before any
 * handshake. The console bridge itself keeps re-dialing the sidecar until the Actor's Xvfb is up, so one
 * connection attempt is enough; the timeout here just bounds that wait.
 */
function readMirrorGreeting(runId: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${CONSOLE_URL.replace('http', 'ws')}/runs/${runId}/browser/ws`);
		const timer = setTimeout(() => {
			ws.terminate();
			reject(new Error('Timed out waiting for the RFB greeting over the viewer websocket'));
		}, timeoutMs);
		ws.once('message', (data) => {
			clearTimeout(timer);
			ws.close();
			resolve(Buffer.from(data as Buffer).toString('latin1'));
		});
		ws.once('close', (code, reason) => {
			clearTimeout(timer);
			reject(new Error(`Viewer websocket closed before any data: ${code} ${reason.toString()}`));
		});
		ws.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

describe('per-Actor browser view: live mirror of the Playwright sample Actor (requires Docker)', () => {
	let isolatedApifyHome: string;

	beforeAll(
		async () => {
			if (!isDockerAvailable()) {
				throw new Error(
					'Docker daemon is not reachable - this e2e case requires one (see requirements/test.md)',
				);
			}

			pullPlaywrightBaseImages();
			buildRuntimeImage(REPO_ROOT, IMAGE_TAG);
			startRuntimeContainer(IMAGE_TAG, CONTAINER_NAME);
			await waitForHttpOk('http://localhost:3333/v2/users/me?token=x');

			isolatedApifyHome = createIsolatedApifyHome();
			loginApifyCli(REPO_ROOT, isolatedApifyHome);
		},
		15 * 60 * 1000,
	);

	afterAll(() => {
		stopRuntimeContainer(CONTAINER_NAME);
		if (isolatedApifyHome) removeIsolatedApifyHome(isolatedApifyHome);
	});

	const samples = [
		{ dir: 'sample_actor_playwright', label: 'TypeScript', input: (n: number) => ({ maxRequestsPerCrawl: n }) },
		{ dir: 'sample_actor_playwright_py', label: 'Python', input: (n: number) => ({ max_requests_per_crawl: n }) },
	];

	for (const sample of samples) {
		it(
			`${sample.label} sample: push -> toggle on -> run: the log names the viewer URL, the viewer websocket reaches a live RFB server while the run crawls, the console links to the page, and the run finishes with the input-dependent item count`,
			async () => {
				const env = apifyEnv(isolatedApifyHome);
				const actorDir = join(REPO_ROOT, sample.dir);

				const pushOutput = apify(['push', '--json'], { cwd: actorDir, env });
				const push = JSON.parse(pushOutput) as PushResult;
				expect(push.build.status).toBe('SUCCEEDED');
				const actorId = push.actor.id;

				const toggle = apify(
					['api', 'POST', `/actor-runtime/browser-view/${actorId}`, '--body', '{"enabled": true}'],
					{ cwd: REPO_ROOT, env },
				);
				expect(JSON.parse(toggle).data.localBrowserView).toEqual({ interactive: false });

				// Enough pages to keep the browser busy while the mirror is probed below.
				const run = startRun(actorId, sample.input(4), env);

				const log = await waitFor(
					() => {
						const text = currentLog(run.id, env);
						return text.includes('Browser view:') ? text : undefined;
					},
					60_000,
					'the browser-view line to appear in the run log',
				);
				expect(log).toContain(`${CONSOLE_URL}/runs/${run.id}/browser`);
				expect(log).toContain('view-only');

				// The mirror: the console's own websocket bridge reaches the sidecar's x11vnc, which greets with the
				// RFB protocol version once the Actor's Xvfb display exists. Chrome starting inside a fresh
				// container can take a while, hence the generous bound.
				const greeting = await readMirrorGreeting(run.id, 120_000);
				expect(greeting.startsWith('RFB 003.')).toBe(true);

				// The console's run page links to the viewer, and the viewer page embeds the noVNC client.
				const runPage = await fetch(`${CONSOLE_URL}/runs/${run.id}`);
				expect(await runPage.text()).toContain(`href="/runs/${run.id}/browser"`);
				const viewerPage = await fetch(`${CONSOLE_URL}/runs/${run.id}/browser`);
				expect(viewerPage.status).toBe(200);
				expect(await viewerPage.text()).toContain('/vendor/novnc/core/rfb.js');
				const client = await fetch(`${CONSOLE_URL}/vendor/novnc/core/rfb.js`);
				expect(client.status).toBe(200);

				// Mirroring changed nothing about the crawl itself: the run finishes and the item count tracks input.
				const finished = await waitFor(
					() => {
						const current = getRun(run.id, env);
						return ['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(current.status)
							? current
							: undefined;
					},
					4 * 60 * 1000,
					'the browser-view run to finish',
				);
				expect(finished.status).toBe('SUCCEEDED');
				const runDetail = JSON.parse(
					apify(['api', 'GET', `actor-runs/${run.id}`], { cwd: REPO_ROOT, env }),
				) as ApiEnvelope<{ defaultDatasetId: string }>;
				const info = JSON.parse(
					apify(['datasets', 'info', runDetail.data.defaultDatasetId, '--json'], { cwd: actorDir, env }),
				) as DatasetInfoResult;
				expect(info.itemCount).toBe(4);

				// Once the run is over its mirror is gone: the viewer page says so, and the websocket is refused.
				const endedPage = await fetch(`${CONSOLE_URL}/runs/${run.id}/browser`);
				expect(await endedPage.text()).toContain('This run has ended');
				await expect(readMirrorGreeting(run.id, 10_000)).rejects.toThrow(/1008/);
			},
			10 * 60 * 1000,
		);
	}

	it(
		'with the toggle cleared, a plain `apify call` of the same Actor runs exactly as before (no mirror, same crawl)',
		() => {
			const env = apifyEnv(isolatedApifyHome);
			const actorDir = join(REPO_ROOT, 'sample_actor_playwright');
			const actorId = (JSON.parse(apify(['push', '--json'], { cwd: actorDir, env })) as PushResult).actor.id;
			apify(['api', 'POST', `/actor-runtime/browser-view/${actorId}`, '--body', '{"enabled": false}'], {
				cwd: REPO_ROOT,
				env,
			});

			const callOutput = apify(['call', '--input', '{"maxRequestsPerCrawl": 2}', '--json'], {
				cwd: actorDir,
				env,
			});
			const call = JSON.parse(callOutput) as CallResult;
			expect(call.run.status).toBe('SUCCEEDED');
			expect(currentLog(call.run.id, env)).not.toContain('Browser view:');

			const info = JSON.parse(
				apify(['datasets', 'info', call.storage.defaultDatasetId, '--json'], { cwd: actorDir, env }),
			) as DatasetInfoResult;
			expect(info.itemCount).toBe(2);
		},
		5 * 60 * 1000,
	);
});
