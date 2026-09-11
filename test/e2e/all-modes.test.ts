/**
 * `requirements/test.md`'s "All advanced modes at once": one run with debug mode, a live dev folder and
 * browser view all on. Each works alone in its own e2e file; this one proves they compose.
 *
 * `sample_actor_playwright` is the only sample that can carry all three - headful for the view, `CMD
 * ["node", ...]` for debug mode. Its base image also starts through an absolute
 * `/home/myuser/xvfb-entrypoint.sh` inside the mounted working directory, which no other case covers.
 *
 * Carries both of `test.md`'s CLI-only exceptions at once (the debug port, the viewer websocket), and
 * starts the run via `apify api`, never `apify call` - a paused run would block the CLI indefinitely.
 * Works on a throwaway copy of the sample, never the committed one: it edits and compiles the source.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
	PLAYWRIGHT_BASE_IMAGE,
	buildRuntimeImage,
	isDockerAvailable,
	pullImage,
	startRuntimeContainer,
	stopRuntimeContainer,
	waitForHttpOk,
} from './helpers/docker.js';
import { CONSOLE_URL, readMirrorGreeting } from './helpers/console-view.js';
import { waitFor } from './helpers/wait.js';
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SAMPLE_ACTOR_DIR = join(REPO_ROOT, 'sample_actor_playwright');
const CONTAINER_NAME = 'actor-runtime-e2e-all-modes';
const IMAGE_TAG = 'actor-runtime:e2e-all-modes';

/** The base image's `WorkingDir`, which the dev folder is mounted over - asserted below, not just assumed. */
const EXPECTED_IMAGE_WORKING_DIR = '/home/myuser';
/** What `language: "auto"` resolves to for this image. */
const DEBUG_PORT = 9229;
/** The default 1024 MB grants 0.25 core - too slow for a headful browser on an e2e budget. */
const RUN_MEMORY_MBYTES = 4096;
const MAX_REQUESTS_PER_CRAWL = 4;

/** Edited in the dev folder after the push: the run printing the edited form is what proves the mount,
 * not the built image, supplied the code. */
const ORIGINAL_MARKER = 'page(s) with a headful Chrome,';
const EDITED_MARKER = 'page(s) with a headful Chrome (all-modes-dev-folder-marker),';

interface RunApi {
	id: string;
	status: string;
	statusMessage?: string;
}

function startRun(actorId: string, input: unknown, env: NodeJS.ProcessEnv): RunApi {
	// Generous: debug mode does not extend the run timeout for the time spent attaching.
	const params = JSON.stringify({ memory: RUN_MEMORY_MBYTES, timeout: 900 });
	const output = apify(
		['api', 'POST', `actors/${actorId}/runs`, '--params', params, '--body', JSON.stringify(input)],
		{ cwd: REPO_ROOT, env },
	);
	return (JSON.parse(output) as ApiEnvelope<RunApi>).data;
}

function getRun(runId: string, env: NodeJS.ProcessEnv): RunApi {
	const output = apify(['api', 'GET', `actor-runs/${runId}`], { cwd: REPO_ROOT, env });
	return (JSON.parse(output) as ApiEnvelope<RunApi>).data;
}

/** Non-streaming, unlike `apify runs log` - see `debug-mode.test.ts`'s `currentLog`. */
function currentLog(runId: string, env: NodeJS.ProcessEnv): string {
	return apify(['api', 'GET', `actor-runs/${runId}/log`], { cwd: REPO_ROOT, env });
}

interface InspectorTarget {
	id: string;
	webSocketDebuggerUrl?: string;
}

/** `--inspect-brk` serves this the moment it listens, before any client attaches. */
async function nodeInspectorTargets(port: number): Promise<InspectorTarget[] | undefined> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/list`);
		if (!res.ok) return undefined;
		const body: unknown = await res.json();
		return Array.isArray(body) && body.length > 0 ? (body as InspectorTarget[]) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The end of an IDE's attach handshake: tell the paused process to run. Without it the run would only
 * ever time out, so this doubles as the proof that a debug pause is releasable with all three modes on.
 * Dialed at `127.0.0.1`, not the target's own `webSocketDebuggerUrl` (Node advertises the `0.0.0.0` it
 * bound inside the container); only the target id is taken from it.
 */
function resumePausedNodeProcess(port: number, targetId: string, timeoutMs = 30_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/${targetId}`);
		const timer = setTimeout(() => {
			ws.terminate();
			reject(new Error('Timed out waiting for the inspector to acknowledge Runtime.runIfWaitingForDebugger'));
		}, timeoutMs);
		// Guarded: `settle` closes the socket, and that close must not report itself as a premature one.
		let settled = false;
		const settle = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			ws.close();
			if (error) reject(error);
			else resolve();
		};
		ws.once('open', () => {
			ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
			ws.send(JSON.stringify({ id: 2, method: 'Runtime.runIfWaitingForDebugger' }));
		});
		ws.on('message', (data) => {
			const message = JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as { id?: number };
			if (message.id === 2) settle();
		});
		ws.once('error', (error) => settle(error));
		ws.once('close', () => settle(new Error('The inspector websocket closed before acknowledging the resume')));
	});
}

describe('all advanced modes at once: debug + live dev folder + browser view on one run (requires Docker)', () => {
	let isolatedApifyHome: string;
	let actorDir: string;
	let actorId: string;

	beforeAll(
		async () => {
			if (!isDockerAvailable()) {
				throw new Error(
					'Docker daemon is not reachable - this e2e case requires one (see requirements/test.md)',
				);
			}

			pullImage(PLAYWRIGHT_BASE_IMAGE);
			buildRuntimeImage(REPO_ROOT, IMAGE_TAG);
			startRuntimeContainer(IMAGE_TAG, CONTAINER_NAME);
			await waitForHttpOk('http://localhost:3333/v2/users/me?token=x');

			isolatedApifyHome = createIsolatedApifyHome();
			loginApifyCli(REPO_ROOT, isolatedApifyHome);

			// The throwaway copy this suite edits and compiles into; both excluded dirs are regenerated below.
			actorDir = mkdtempSync(join(tmpdir(), 'actor-runtime-e2e-all-modes-actor-'));
			const excluded = [join(SAMPLE_ACTOR_DIR, 'node_modules'), join(SAMPLE_ACTOR_DIR, 'dist')];
			cpSync(SAMPLE_ACTOR_DIR, actorDir, {
				recursive: true,
				filter: (src) => !excluded.some((dir) => src === dir || src.startsWith(`${dir}/`)),
			});
			// `mkdtemp` makes it 0700. Alone among the samples' base images, this one runs as a non-root
			// `myuser`, which otherwise could not read the folder mounted over its working directory.
			chmodSync(actorDir, 0o777);

			// Pushed BEFORE the edit below, so the image carries the pristine source and the edited marker in
			// the run's log is attributable to the mount alone.
			const push = JSON.parse(
				apify(['push', '--json'], { cwd: actorDir, env: apifyEnv(isolatedApifyHome) }),
			) as PushResult;
			if (push.build.status !== 'SUCCEEDED') {
				throw new Error(`apify push of the sample Actor ended with build status ${push.build.status}`);
			}
			actorId = push.actor.id;

			// `--ignore-scripts` skips the sample's `postinstall` browser download - the run's browsers come
			// from the image, and nothing here needs them on the host.
			execFileSync('npm', ['install', '--ignore-scripts'], { cwd: actorDir, stdio: 'inherit' });

			// The edit + recompile the run must pick up with no push/build in between - the dev folder's whole
			// point. Here rather than in the test body so a `retry` does not try to edit it twice.
			const mainTs = join(actorDir, 'src', 'main.ts');
			const originalMainTs = readFileSync(mainTs, 'utf8');
			if (!originalMainTs.includes(ORIGINAL_MARKER)) {
				throw new Error(`${mainTs} no longer contains the marker line this suite edits`);
			}
			writeFileSync(mainTs, originalMainTs.replace(ORIGINAL_MARKER, EDITED_MARKER));
			execFileSync('npm', ['run', 'build'], { cwd: actorDir, stdio: 'inherit' });
		},
		20 * 60 * 1000,
	);

	afterAll(() => {
		stopRuntimeContainer(CONTAINER_NAME);
		if (isolatedApifyHome) removeIsolatedApifyHome(isolatedApifyHome);
		// Best-effort, like `stopRuntimeContainer`'s cleanup. This folder is the container's `HOME`, so
		// Chrome leaves dot-directories owned by the image's non-root `myuser` - never the uid running this
		// suite, on either engine - and the removal hits EACCES. Not worth failing an otherwise green suite.
		if (actorDir) {
			try {
				rmSync(actorDir, { recursive: true, force: true });
			} catch (error) {
				console.warn(`Could not fully remove the temporary Actor folder ${actorDir}: ${String(error)}`);
			}
		}
	});

	it(
		'one run with all three toggles on: it pauses for a debugger, mirrors its display live, runs the locally recompiled source once released, and finishes SUCCEEDED with an input-dependent item count',
		async () => {
			const env = apifyEnv(isolatedApifyHome);

			// Three persistent per-Actor toggles, each through its own documented endpoint.
			const devFolder = apify(
				['api', 'POST', `/actor-runtime/dev-folder/${actorId}`, '--body', JSON.stringify(actorDir)],
				{ cwd: REPO_ROOT, env },
			);
			expect(JSON.parse(devFolder).data.localDevFolder).toBe(actorDir);
			const debug = apify(['api', 'POST', `/actor-runtime/debug/${actorId}`, '--body', '{"enabled": true}'], {
				cwd: REPO_ROOT,
				env,
			});
			expect(JSON.parse(debug).data.localDebug).toEqual({ language: 'auto', port: 5678 });
			const browserView = apify(
				['api', 'POST', `/actor-runtime/browser-view/${actorId}`, '--body', '{"enabled": true}'],
				{ cwd: REPO_ROOT, env },
			);
			expect(JSON.parse(browserView).data.localBrowserView).toEqual({ interactive: false });

			const run = startRun(actorId, { maxRequestsPerCrawl: MAX_REQUESTS_PER_CRAWL }, env);

			// All three announce themselves in the same log, and the debug line lands last - so waiting on it
			// waits on all of them.
			const pausedLog = await waitFor(
				() => {
					const text = currentLog(run.id, env);
					return text.includes('Debug mode: this run is paused') ? text : undefined;
				},
				2 * 60 * 1000,
				'the debug attach line to appear in the run log',
			);
			expect(pausedLog).toContain(`Live dev folder: ${actorDir}`);
			expect(pausedLog).toContain(EXPECTED_IMAGE_WORKING_DIR);
			expect(pausedLog).toContain(`Browser view: live mirror of this run's display`);
			expect(pausedLog).toContain(`${CONSOLE_URL}/runs/${run.id}/browser`);
			expect(pausedLog).toContain(`0.0.0.0:${DEBUG_PORT}`);
			expect(pausedLog).toContain(`127.0.0.1:${DEBUG_PORT}`);
			// The mount hides the image's `xvfb-entrypoint.sh`; the driver preserves it, or nothing would start.
			expect(pausedLog).toContain(`starts through ${EXPECTED_IMAGE_WORKING_DIR}/xvfb-entrypoint.sh`);
			// The pause is real: no user code has run, not even the Actor's own first log line.
			expect(pausedLog).not.toContain('Crawling up to');
			expect(getRun(run.id, env).status).toBe('RUNNING');

			// The real inspector protocol, on a container that already carries the mount and the sidecar.
			const targets = await waitFor(
				() => nodeInspectorTargets(DEBUG_PORT),
				60_000,
				`127.0.0.1:${DEBUG_PORT} to answer the Node inspector protocol`,
			);
			await resumePausedNodeProcess(DEBUG_PORT, targets[0]!.id);

			// Released, the Actor runs the dev folder's compiled source rather than the image's own `dist/`.
			const runningLog = await waitFor(
				() => {
					const text = currentLog(run.id, env);
					return text.includes('Crawling up to') ? text : undefined;
				},
				2 * 60 * 1000,
				'the Actor to reach its own first log line after the debugger released it',
			);
			expect(runningLog).toContain(EDITED_MARKER);

			// The mirror, while that same run crawls. Chrome in a fresh container is slow to appear, hence the
			// generous bound.
			const greeting = await readMirrorGreeting(run.id, 3 * 60 * 1000);
			expect(greeting.startsWith('RFB 003.')).toBe(true);

			const finished = await waitFor(
				() => {
					const current = getRun(run.id, env);
					return ['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(current.status)
						? current
						: undefined;
				},
				8 * 60 * 1000,
				'the all-modes run to finish',
			);
			expect(finished.status).toBe('SUCCEEDED');

			// None of the three changed the crawl itself: the item count still tracks the input.
			const runDetail = JSON.parse(
				apify(['api', 'GET', `actor-runs/${run.id}`], { cwd: REPO_ROOT, env }),
			) as ApiEnvelope<{ defaultDatasetId: string }>;
			const info = JSON.parse(
				apify(['datasets', 'info', runDetail.data.defaultDatasetId, '--json'], { cwd: actorDir, env }),
			) as DatasetInfoResult;
			expect(info.itemCount).toBe(MAX_REQUESTS_PER_CRAWL);

			const finalLog = currentLog(run.id, env);
			expect(finalLog).toContain(EDITED_MARKER);
			expect(finalLog).not.toContain(ORIGINAL_MARKER);

			// Once the run is over its mirror is gone, exactly as for a browser-view-only run.
			const endedPage = await fetch(`${CONSOLE_URL}/runs/${run.id}/browser`);
			expect(await endedPage.text()).toContain('This run has ended');
			await expect(readMirrorGreeting(run.id, 10_000)).rejects.toThrow(/1008/);
		},
		// One retry: the sample crawls a real site, whose navigations occasionally time out on CI runners.
		{ timeout: 20 * 60 * 1000, retry: 1 },
	);
});
