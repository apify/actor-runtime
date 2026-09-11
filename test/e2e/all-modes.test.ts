/**
 * E2E case for `requirements/test.md`'s "All advanced modes at once": one run of one Actor with debug
 * mode, a live dev folder, and browser view ALL on. Each of the three already has an e2e file of its own
 * proving it works alone; this file exists because they have to compose - the driver builds a single
 * container out of all three (`docker-driver.ts: startRun` merges the dev-folder bind + its
 * `node_modules` volume, the debug port publish, and the browser-view X-socket volume into one
 * `createContainer` call), and nothing else exercises that combination end to end.
 *
 * `sample_actor_playwright` is the only sample that can carry all three at once: browser view needs a
 * headful browser (it runs Chrome with `headless: false`), and debug mode needs an image whose `CMD`
 * invokes `node` directly (its Dockerfile's `CMD ["node", "dist/main.js"]`), which is also what makes
 * `language: "auto"` resolve. Its base image, `apify/actor-node-playwright-chrome`, also starts through
 * `/home/myuser/xvfb-entrypoint.sh` - an ABSOLUTE path inside the working directory the dev folder is
 * mounted over - so this is the only e2e case where the mount has to preserve an entrypoint spelled that
 * way (`docker-driver.ts: entryHiddenByDevMount`).
 *
 * Driven by `apify` commands, with the two exceptions `test.md` already documents and this combination
 * needs both of at once: the debug port is spoken to directly (an IDE attaching), and the console's
 * viewer websocket is opened directly (a developer's browser opening the view).
 *
 * The run is started with `apify api POST actors/<id>/runs`, never `apify call`: a debug run pauses
 * before its first line, so `apify call` would block for the run's whole lifetime instead of letting this
 * test attach and release it.
 *
 * Works against a throwaway copy of `sample_actor_playwright` in a temp directory, never the committed
 * sample: this suite edits `src/main.ts` and compiles into the copy's own `dist/`.
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

/** `apify/actor-node-playwright-chrome`'s own `WorkingDir`, which the dev folder is mounted over.
 * Asserted through the run's own log rather than only assumed here, so a base image that moves it fails
 * with an assertion that explains why. */
const EXPECTED_IMAGE_WORKING_DIR = '/home/myuser';
/** Node's default debug port, which `language: "auto"` resolves to for this image. */
const DEBUG_PORT = 9229;
/** The default 1024 MB grants 0.25 core, on which a headful browser is too slow for a tight e2e budget. */
const RUN_MEMORY_MBYTES = 4096;
/** Enough pages to keep the browser busy while the mirror is probed, and an item count that tracks input. */
const MAX_REQUESTS_PER_CRAWL = 4;

/** A line the sample Actor logs from its own source, edited in the dev folder between the push and the
 * run: the run printing the edited form is what proves the mount (not the built image) supplied the code. */
const ORIGINAL_MARKER = 'page(s) with a headful Chrome,';
const EDITED_MARKER = 'page(s) with a headful Chrome (all-modes-dev-folder-marker),';

interface RunApi {
	id: string;
	status: string;
	statusMessage?: string;
}

function startRun(actorId: string, input: unknown, env: NodeJS.ProcessEnv): RunApi {
	// A generous run timeout: debug mode does NOT extend it for the time spent attaching (the run's own
	// log says so), so the pause below eats into the same budget as the crawl.
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

/** Non-streaming log fetch (see `debug-mode.test.ts`'s `currentLog` for why not `apify runs log`: a
 * paused run never ends, so the streaming command would block for the run's lifetime). */
function currentLog(runId: string, env: NodeJS.ProcessEnv): string {
	return apify(['api', 'GET', `actor-runs/${runId}/log`], { cwd: REPO_ROOT, env });
}

interface InspectorTarget {
	id: string;
	webSocketDebuggerUrl?: string;
}

/** Node's inspector protocol answers `GET /json/list` with a JSON array describing the debug target -
 * served the moment `--inspect-brk` starts listening, before any client attaches. */
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
 * What an IDE does at the end of its attach handshake, and the one thing this test needs from it: connect
 * to the paused inspector and tell it to run. Without this the Actor would sit at `--inspect-brk`'s pause
 * forever and the run would only ever time out - so this is also the assertion that a debug pause is
 * genuinely releasable while the other two modes are active.
 *
 * Dialed at `127.0.0.1:<port>` rather than at the target's own `webSocketDebuggerUrl`, which Node
 * advertises with the address it bound inside the container (`0.0.0.0`); only the target id from it is
 * used. Closing the socket afterwards does not re-pause the process.
 */
function resumePausedNodeProcess(port: number, targetId: string, timeoutMs = 30_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/${targetId}`);
		const timer = setTimeout(() => {
			ws.terminate();
			reject(new Error('Timed out waiting for the inspector to acknowledge Runtime.runIfWaitingForDebugger'));
		}, timeoutMs);
		// `settle` closes the socket, which fires `close` - hence the guard: a close this function asked for
		// must not then report itself as a premature one.
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

			// The throwaway copy this suite edits and compiles into. `node_modules`/`dist` are excluded -
			// both are regenerated below, inside the copy.
			actorDir = mkdtempSync(join(tmpdir(), 'actor-runtime-e2e-all-modes-actor-'));
			const excluded = [join(SAMPLE_ACTOR_DIR, 'node_modules'), join(SAMPLE_ACTOR_DIR, 'dist')];
			cpSync(SAMPLE_ACTOR_DIR, actorDir, {
				recursive: true,
				filter: (src) => !excluded.some((dir) => src === dir || src.startsWith(`${dir}/`)),
			});
			// `mkdtemp` creates the directory 0700, owned by whoever runs this suite. Unlike every other
			// sample's base image, `apify/actor-node-playwright-chrome` runs as its own non-root `myuser`,
			// which then could not even read the folder bind-mounted over its working directory.
			chmodSync(actorDir, 0o777);

			// Pushed BEFORE the local edit and compile below, so the image is built from the pristine source:
			// the run's log carrying the edited marker is then attributable to the mount alone.
			const push = JSON.parse(
				apify(['push', '--json'], { cwd: actorDir, env: apifyEnv(isolatedApifyHome) }),
			) as PushResult;
			if (push.build.status !== 'SUCCEEDED') {
				throw new Error(`apify push of the sample Actor ended with build status ${push.build.status}`);
			}
			actorId = push.actor.id;

			// A real local install + compile, the way a developer using the dev folder works.
			// `--ignore-scripts` skips the sample's `postinstall` browser download: the browsers the run uses
			// come from the image, and nothing here needs them on the host. This is a host-side install,
			// distinct from what `apify push` sent the runtime (source only - the runtime's own build
			// installs and compiles again, inside the image).
			execFileSync('npm', ['install', '--ignore-scripts'], { cwd: actorDir, stdio: 'inherit' });

			// The edit + local recompile the run must pick up with no `apify push`/build in between - the
			// dev folder's whole point. Done here rather than in the test body so the case's `retry` re-runs
			// against an already-edited, already-compiled folder instead of trying to edit it twice.
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
		// Best-effort, like `stopRuntimeContainer`'s own cleanup - never a reason to fail a suite whose
		// assertions have all already run. This folder IS the Actor's `HOME` inside the container (the
		// mount covers `/home/myuser`), so Chrome leaves its dot-directories in it, owned by whatever host
		// uid the container's `myuser` mapped to - the runner's own uid under rootful Docker's uid 1000,
		// but a subuid the runner cannot touch under ROOTLESS Podman, where the removal then fails with
		// EACCES. `rm` still takes out everything it is allowed to before giving up.
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

			// All three toggles, each through its own documented endpoint. None of them is a per-run flag:
			// they are set once and every later run of this Actor carries all three.
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

			// All three announce themselves in the SAME run's log. The debug line lands last of the three
			// (the driver writes it right before `createContainer`), so waiting on it waits on all of them.
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
			// The dev folder has no `xvfb-entrypoint.sh` of its own, so the mount hides the image's - which
			// the driver preserves, or the container could not have started at all.
			expect(pausedLog).toContain(`starts through ${EXPECTED_IMAGE_WORKING_DIR}/xvfb-entrypoint.sh`);
			// The pause is real: no user code has run, not even the Actor's own first log line.
			expect(pausedLog).not.toContain('Crawling up to');
			expect(getRun(run.id, env).status).toBe('RUNNING');

			// The published debug port answers the real inspector protocol - with the dev-folder mount and the
			// browser-view sidecar both already in place on this same container.
			const targets = await waitFor(
				() => nodeInspectorTargets(DEBUG_PORT),
				60_000,
				`127.0.0.1:${DEBUG_PORT} to answer the Node inspector protocol`,
			);
			await resumePausedNodeProcess(DEBUG_PORT, targets[0]!.id);

			// Released, the Actor runs the source compiled into the dev folder above, not the image's own
			// `dist/` - the edited marker is the proof, and it is also proof that a debug pause hands control
			// back to the mounted code rather than to whatever the image was built from.
			const runningLog = await waitFor(
				() => {
					const text = currentLog(run.id, env);
					return text.includes('Crawling up to') ? text : undefined;
				},
				2 * 60 * 1000,
				'the Actor to reach its own first log line after the debugger released it',
			);
			expect(runningLog).toContain(EDITED_MARKER);

			// The mirror, while that same run crawls: the console's websocket bridge reaches the sidecar's
			// x11vnc on the display the Actor's Chrome draws on. Chrome starting inside a fresh container can
			// take a while, hence the generous bound.
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
		// One retry: the sample crawls a real external site (deliberately - the route out of an Actor is part
		// of what is tested), and CI runners occasionally see its navigations time out; a defect reproduces.
		{ timeout: 20 * 60 * 1000, retry: 1 },
	);
});
