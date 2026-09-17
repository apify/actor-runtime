import { execFileSync } from 'node:child_process';
import process from 'node:process';

import { COMPATIBILITY_BUILD_PLATFORM, isMissingManifestForBuildPlatform } from '../../../src/driver/build-platform.js';

/**
 * The container CLI the suite drives the host engine with - `docker` by default, `podman` via
 * `CONTAINER_CLI=podman`. Both accept the exact `build`/`pull`/`run`/`logs`/`rm`/`volume rm` invocations
 * below unchanged; the runtime container itself only ever sees the engine's Docker-compatible API socket.
 */
const CONTAINER_CLI = process.env.CONTAINER_CLI === 'podman' ? 'podman' : 'docker';

/** Default location of the engine's API socket on the host, per CLI: Docker's, or rootful Podman's
 * (`podman.socket` / `podman system service`). A `unix://` `DOCKER_HOST` overrides both - the way to
 * point the suite at a rootless Podman socket (`$XDG_RUNTIME_DIR/podman/podman.sock`). */
const DEFAULT_SOCKET_PATH = CONTAINER_CLI === 'podman' ? '/run/podman/podman.sock' : '/var/run/docker.sock';

/** Where the runtime container looks for the socket - `docker-driver.ts`'s dockerode default. */
const RUNTIME_SOCKET_PATH = '/var/run/docker.sock';

/** The host socket path the runtime container gets mounted, so builds and runs land on the same engine
 * the suite itself is talking to. */
export function hostEngineSocketPath(): string {
	const dockerHost = process.env.DOCKER_HOST;
	if (dockerHost?.startsWith('unix://')) return dockerHost.slice('unix://'.length);
	return DEFAULT_SOCKET_PATH;
}

/** True when a Docker-API-compatible engine (Docker, or Podman via `CONTAINER_CLI=podman`) is reachable
 * from this process. Gates the whole e2e suite. */
export function isDockerAvailable(): boolean {
	try {
		execFileSync(CONTAINER_CLI, ['info'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

export function buildRuntimeImage(repoRoot: string, tag: string): void {
	execFileSync(CONTAINER_CLI, ['build', '-t', tag, repoRoot], { stdio: 'inherit' });
}

export function pullBaseImages(): void {
	// Pre-pulled here rather than left to the first build, per `test.md`'s documented CI requirement -
	// building an Actor image is the one step that still needs network, and doing it once up front
	// keeps the timing of the actual push/call assertions predictable. Fully-qualified names so Podman's
	// short-name resolution never has to guess a registry.
	for (const image of [
		'docker.io/apify/actor-node:24',
		'docker.io/apify/actor-python:3.13',
		'docker.io/library/python:3.11-slim',
	]) {
		pullImage(image);
	}
}

/** `sample_actor_playwright/Dockerfile`'s base image - pulled only by its own e2e file, not by
 * `pullBaseImages`, since it is large and no other file builds against it. */
export const PLAYWRIGHT_BASE_IMAGE = 'docker.io/apify/actor-node-playwright-chrome:24-1.61.1';

/** `sample_actor_nonstandard`'s base image, pulled only by `nonstandard-actor.test.ts`. */
export const NONSTANDARD_ACTOR_BASE_IMAGE = 'docker.io/library/python:3.11-slim';

/** Base image of the no-`WORKDIR` Actor `nonstandard-actor.test.ts` builds inline. */
export const NO_WORKDIR_ACTOR_BASE_IMAGE = 'docker.io/library/busybox';

/** `sample_actor_playwright_py/Dockerfile`'s base image. */
export const PYTHON_PLAYWRIGHT_BASE_IMAGE = 'docker.io/apify/actor-python-playwright:3.14-1.61.0';

/** Pre-pull one base image, with the same fallback the runtime's builds have (`build-platform.ts`):
 * an image with no build for the host's architecture is pulled for `linux/amd64`, which is what the
 * build will use anyway. Every other pull failure is the suite's failure, as before. */
export function pullImage(image: string): void {
	try {
		execFileSync(CONTAINER_CLI, ['pull', image], { stdio: ['ignore', 'inherit', 'pipe'] });
		return;
	} catch (error) {
		const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? '';
		process.stderr.write(stderr);
		if (!isMissingManifestForBuildPlatform(stderr)) throw error;
		process.stdout.write(
			`${image} has no build for this machine's architecture; pulling it for ` +
				`${COMPATIBILITY_BUILD_PLATFORM}, as the runtime's own build fallback does.\n`,
		);
	}
	execFileSync(CONTAINER_CLI, ['pull', '--platform', COMPATIBILITY_BUILD_PLATFORM, image], { stdio: 'inherit' });
}

/**
 * `--security-opt label=disable` for the runtime container on a Podman host with SELinux enforcing
 * (Fedora; the Fedora-based VM of Podman Desktop / `podman machine` on macOS and Windows): without it,
 * SELinux keeps the container from the engine's socket bind-mounted into it - README's "Running with
 * Podman" documents the same flag for users. Docker hosts and Podman hosts without SELinux get nothing
 * extra, so the suite there runs the documented command verbatim, as before.
 */
function engineSecurityOptions(): string[] {
	if (CONTAINER_CLI !== 'podman') return [];
	try {
		const enabled = execFileSync(CONTAINER_CLI, ['info', '--format', '{{.Host.Security.SELinuxEnabled}}'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
		return enabled === 'true' ? ['--security-opt', 'label=disable'] : [];
	} catch {
		return [];
	}
}

export function startRuntimeContainer(tag: string, containerName: string): void {
	// A previous run that died before its `afterAll` (killed vitest, a CI job cancelled or timed out on a
	// persistent self-hosted runner) leaves a container of this name, and with it the fixed host ports
	// below, in place; `docker run` would then fail with "name is already in use" / "port is already
	// allocated". The name is this suite's own, so removing whatever holds it is always the right call.
	removeContainerAndDataVolume(containerName);
	execFileSync(
		CONTAINER_CLI,
		[
			'run',
			'-d',
			'--name',
			containerName,
			// Host ports are fixed, not derived from `containerName` - only one runtime container can ever
			// be bound to 3333/3000 at a time. `package.json`'s `test:e2e` script therefore runs
			// `vitest run test/e2e --no-file-parallelism`: if a second e2e file's `beforeAll` ever raced
			// this one, the loser's `docker run` would fail with "port is already allocated" and take that
			// file's whole suite down with it. Adding an e2e file is safe as long as the suite stays
			// serialized on one daemon - do not drop `--no-file-parallelism` without also parameterizing
			// these two ports per container. CI parallelizes by running each file in its own job instead
			// (`.github/workflows/ci.yml`).
			'-p',
			'3333:3333',
			'-p',
			'3000:3000',
			'-v',
			`${hostEngineSocketPath()}:${RUNTIME_SOCKET_PATH}`,
			'-v',
			`${containerName}-data:/data`,
			...engineSecurityOptions(),
			tag,
		],
		{ stdio: 'inherit' },
	);
}

export function stopRuntimeContainer(containerName: string): void {
	// Dump the runtime container's own logs before force-removing it - the workflow's "Dump runtime
	// container logs on failure" step tries `docker logs <name>` too, but this `afterAll` runs first and
	// already removes the container by the time that step gets to run, so it always finds "No such
	// container" and the server-side view of a failed e2e request is lost. Printing here, into the same
	// test stdout the failure shows up in, actually captures it; the workflow step stays as a harmless
	// backstop for cases where the process is killed before `afterAll` runs at all.
	try {
		const logs = execFileSync(CONTAINER_CLI, ['logs', '--tail', '300', containerName], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		process.stdout.write(`\n--- ${containerName} container logs (last 300 lines) ---\n`);
		process.stdout.write(logs);
		process.stdout.write(`--- end ${containerName} container logs ---\n\n`);
	} catch {
		// best-effort: the container may already be gone (never started, already removed) - diagnostics
		// only, never a reason to skip the cleanup below.
	}
	removeContainerAndDataVolume(containerName);
}

/** Force-removes the runtime container and its `<name>-data` volume; a no-op when neither exists. */
function removeContainerAndDataVolume(containerName: string): void {
	try {
		execFileSync(CONTAINER_CLI, ['rm', '-f', containerName], { stdio: 'ignore' });
	} catch {
		// best-effort cleanup
	}
	try {
		execFileSync(CONTAINER_CLI, ['volume', 'rm', '-f', `${containerName}-data`], { stdio: 'ignore' });
	} catch {
		// best-effort cleanup
	}
}

export async function waitForHttpOk(url: string, timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url);
			if (res.ok || res.status < 500) return;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`Timed out waiting for ${url} to respond: ${String(lastError)}`);
}
