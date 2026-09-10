/** `DockerDriver`'s browser-view surface (actor-driver.md: "Browser view"): `startBrowserViewer` /
 * `stopBrowserViewer` and `startRun`'s X-socket volume mount. Split out of `docker-driver.test.ts` (one
 * file per area, like `docker-driver-debug.test.ts`). No daemon here - a stub `dockerode` records calls. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Docker from 'dockerode';

import { DockerDriver } from '../../src/driver/docker-driver.js';
import { stubDockerForRun } from './helpers/docker-stubs.js';

const PAYLOAD_ENV = 'ACTOR_RUNTIME_BROWSER_VIEWER_PAYLOAD_DIR';

/** A stub covering exactly what `startBrowserViewer`/`stopBrowserViewer` call. `imagePresent` controls
 * whether `getImage(tag).inspect()` finds the imported sidecar image already (a previous process imported
 * it) or 404s (first use on this daemon). */
function stubDockerForViewer(options: { imagePresent?: boolean; ipAddress?: string } = {}) {
	const calls: string[] = [];
	const inspectImage = vi.fn(async () => {
		calls.push('inspectImage');
		if (options.imagePresent) return { Id: 'sha256:present' };
		throw Object.assign(new Error('no such image'), { statusCode: 404 });
	});
	const getImage = vi.fn((_tag: string) => ({ inspect: inspectImage }));
	const importImage = vi.fn(async (_file: unknown, _opts: { repo: string; tag: string }) => {
		calls.push('importImage');
		return new PassThrough();
	});
	const followProgress = vi.fn((_stream: unknown, onFinished: (err: Error | null, res: unknown[]) => void) => {
		onFinished(null, []);
	});
	const createVolume = vi.fn(async (_opts: Docker.VolumeCreateOptions) => {
		calls.push('createVolume');
		return {};
	});
	const container = {
		id: 'viewer-container-id',
		start: vi.fn(async () => {
			calls.push('start');
		}),
		inspect: vi.fn(async () => ({
			NetworkSettings: {
				Networks: { 'apify-local': { IPAddress: options.ipAddress ?? '172.18.0.9' } },
			},
		})),
		remove: vi.fn(async (_opts?: Record<string, unknown>) => {
			calls.push('removeContainer');
		}),
	};
	const createContainer = vi.fn(async (_opts: Docker.ContainerCreateOptions) => {
		calls.push('createContainer');
		return container;
	});
	const volumeRemove = vi.fn(async (_opts?: Record<string, unknown>) => {
		calls.push('removeVolume');
	});
	const getVolume = vi.fn((_name: string) => ({ remove: volumeRemove }));
	const docker = {
		getImage,
		importImage,
		createVolume,
		createContainer,
		getVolume,
		modem: { followProgress },
	} as unknown as Docker;
	return { docker, calls, getImage, importImage, createVolume, createContainer, container, getVolume, volumeRemove };
}

describe('DockerDriver.startBrowserViewer / stopBrowserViewer', () => {
	let payloadDir: string;
	const originalEnv = process.env[PAYLOAD_ENV];

	beforeEach(() => {
		payloadDir = mkdtempSync(join(tmpdir(), 'actor-runtime-browser-viewer-payload-test-'));
		writeFileSync(join(payloadDir, 'rootfs.tar'), 'fake-rootfs-tar');
		writeFileSync(join(payloadDir, 'version.txt'), 'abc123def456\n');
		process.env[PAYLOAD_ENV] = payloadDir;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(payloadDir, { recursive: true, force: true });
		if (originalEnv === undefined) delete process.env[PAYLOAD_ENV];
		else process.env[PAYLOAD_ENV] = originalEnv;
	});

	it('imports the bundled rootfs under the payload version tag when the daemon has no such image yet, then creates the tmpfs 1777 volume and starts the labelled sidecar on apify-local', async () => {
		const stub = stubDockerForViewer();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const handle = await driver.startBrowserViewer({ runId: 'run-1', interactive: false });

		expect(stub.calls).toEqual(['inspectImage', 'importImage', 'createVolume', 'createContainer', 'start']);
		expect(stub.getImage).toHaveBeenCalledWith('localhost/actor-runtime/browser-viewer:abc123def456');
		// `name:tag` in `repo`, no separate `tag`: Podman 3.x ignores the `tag` parameter.
		expect(stub.importImage.mock.calls[0]![1]).toEqual({
			repo: 'localhost/actor-runtime/browser-viewer:abc123def456',
		});

		const [volumeOptions] = stub.createVolume.mock.calls[0]!;
		expect(volumeOptions.Name).toBe('actor-runtime-x11-run-1');
		expect(volumeOptions.Driver).toBe('local');
		expect(volumeOptions.DriverOpts).toEqual({ type: 'tmpfs', device: 'tmpfs', o: 'mode=1777' });
		expect(volumeOptions.Labels).toEqual({ 'actor-runtime.runId': 'run-1', 'actor-runtime.browserViewer': 'true' });

		const [containerOptions] = stub.createContainer.mock.calls[0]!;
		expect(containerOptions.Image).toBe('localhost/actor-runtime/browser-viewer:abc123def456');
		expect(containerOptions.name).toBe('actor-runtime-browser-viewer-run-1');
		expect(containerOptions.Cmd).toEqual(['/bin/sh', '/apify-browser-viewer.sh']);
		expect(containerOptions.Env).toEqual(['APIFY_BROWSER_VIEWER_INTERACTIVE=0', 'APIFY_BROWSER_VIEWER_PORT=5900']);
		expect(containerOptions.Labels).toEqual({
			'actor-runtime.runId': 'run-1',
			'actor-runtime.browserViewer': 'true',
		});
		expect(containerOptions.HostConfig?.NetworkMode).toBe('apify-local');
		expect(containerOptions.HostConfig?.Mounts).toEqual([
			{ Type: 'volume', Source: 'actor-runtime-x11-run-1', Target: '/tmp/.X11-unix' },
		]);
		// Never published on the host (system.md): no port bindings of any kind.
		expect(containerOptions.ExposedPorts).toBeUndefined();
		expect(containerOptions.HostConfig?.PortBindings).toBeUndefined();

		expect(handle).toEqual({ vncHost: '172.18.0.9', vncPort: 5900, x11SocketVolume: 'actor-runtime-x11-run-1' });
	});

	it('passes interactive=1 through to the sidecar env when asked for an interactive mirror', async () => {
		const stub = stubDockerForViewer({ imagePresent: true });
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		await driver.startBrowserViewer({ runId: 'run-2', interactive: true });

		expect(stub.createContainer.mock.calls[0]![0].Env).toContain('APIFY_BROWSER_VIEWER_INTERACTIVE=1');
	});

	it('skips the import when the image is already present, and imports at most once per process for two runs', async () => {
		const stub = stubDockerForViewer({ imagePresent: true });
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		await driver.startBrowserViewer({ runId: 'run-a', interactive: false });
		await driver.startBrowserViewer({ runId: 'run-b', interactive: false });

		expect(stub.importImage).not.toHaveBeenCalled();
		expect(stub.getImage).toHaveBeenCalledTimes(1);
	});

	it("when this process runs in a container that could not join apify-local (rootless Podman), the sidecar shares this container's network namespace on a port of its own and is reached on localhost", async () => {
		vi.stubEnv('HOSTNAME', 'abc123def456');
		const stub = stubDockerForViewer({ imagePresent: true });
		const driver = new DockerDriver(stub.docker);
		driver.available = true; // `onActorNetwork` stays false: `init()` never attached this container.

		const handle = await driver.startBrowserViewer({ runId: 'run-netns', interactive: false });

		const [containerOptions] = stub.createContainer.mock.calls[0]!;
		expect(containerOptions.HostConfig?.NetworkMode).toBe('container:abc123def456');
		expect(handle.vncHost).toBe('127.0.0.1');
		expect(handle.vncPort).toBeGreaterThan(0);
		expect(handle.vncPort).not.toBe(5900);
		expect(containerOptions.Env).toContain(`APIFY_BROWSER_VIEWER_PORT=${handle.vncPort}`);
		// Nothing to look up on the network: the address is this container's own loopback.
		expect(stub.container.inspect).not.toHaveBeenCalled();
	});

	it('joins apify-local as usual when this container did attach to it, even though it runs in a container', async () => {
		vi.stubEnv('HOSTNAME', 'abc123def456');
		const stub = stubDockerForViewer({ imagePresent: true });
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		(driver as unknown as { onActorNetwork: boolean }).onActorNetwork = true;

		const handle = await driver.startBrowserViewer({ runId: 'run-alias', interactive: false });

		const [containerOptions] = stub.createContainer.mock.calls[0]!;
		expect(containerOptions.HostConfig?.NetworkMode).toBe('apify-local');
		expect(handle).toEqual({
			vncHost: '172.18.0.9',
			vncPort: 5900,
			x11SocketVolume: 'actor-runtime-x11-run-alias',
		});
	});

	it('falls back to the sidecar container name as vncHost when the daemon reports no IP on apify-local', async () => {
		const stub = stubDockerForViewer({ imagePresent: true, ipAddress: '' });
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const handle = await driver.startBrowserViewer({ runId: 'run-3', interactive: false });

		expect(handle.vncHost).toBe('actor-runtime-browser-viewer-run-3');
	});

	it('fails with a clear message, before any daemon call, when the sidecar payload is missing from disk (runtime running from source)', async () => {
		rmSync(join(payloadDir, 'version.txt'));
		const stub = stubDockerForViewer();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		await expect(driver.startBrowserViewer({ runId: 'run-4', interactive: false })).rejects.toThrow(
			/browser-view sidecar payload is missing/,
		);
		expect(stub.calls).toEqual([]);
	});

	it('fails fast when the driver is unavailable', async () => {
		const stub = stubDockerForViewer();
		const driver = new DockerDriver(stub.docker);

		await expect(driver.startBrowserViewer({ runId: 'run-5', interactive: false })).rejects.toThrow(
			/Docker is not available/,
		);
		expect(stub.calls).toEqual([]);
	});

	it('tears the volume and container down again when the sidecar fails to start (on the Actor network and on the default one), then rethrows the first failure', async () => {
		const stub = stubDockerForViewer({ imagePresent: true });
		stub.container.start.mockRejectedValue(new Error('daemon said no'));
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		await expect(driver.startBrowserViewer({ runId: 'run-6', interactive: false })).rejects.toThrow(
			'daemon said no',
		);

		expect(stub.container.remove).toHaveBeenCalledWith({ force: true });
		expect(stub.getVolume).toHaveBeenCalledWith('actor-runtime-x11-run-6');
		expect(stub.volumeRemove).toHaveBeenCalledWith({ force: true });
		// Nothing is left tracked - a later stop for this run is a no-op.
		stub.calls.length = 0;
		await driver.stopBrowserViewer('run-6');
		expect(stub.calls).toEqual([]);
	});

	it('when the sidecar cannot start on apify-local but does on the default network, keeps that sidecar, warns once, and puts every later sidecar straight on the default network', async () => {
		const stub = stubDockerForViewer({ imagePresent: true });
		stub.container.start.mockRejectedValueOnce(new Error('CNI network "apify-local" not found'));
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		const handle = await driver.startBrowserViewer({ runId: 'run-cni', interactive: false });

		expect(stub.createContainer).toHaveBeenCalledTimes(2);
		expect(stub.createContainer.mock.calls[0]![0].HostConfig?.NetworkMode).toBe('apify-local');
		expect(stub.createContainer.mock.calls[1]![0].HostConfig?.NetworkMode).toBeUndefined();
		expect(handle).toEqual({ vncHost: '172.18.0.9', vncPort: 5900, x11SocketVolume: 'actor-runtime-x11-run-cni' });
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]![0])).toContain('CNI network "apify-local" not found');

		await driver.startBrowserViewer({ runId: 'run-cni-2', interactive: false });
		expect(stub.createContainer).toHaveBeenCalledTimes(3);
		expect(stub.createContainer.mock.calls[2]![0].HostConfig?.NetworkMode).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it('stopBrowserViewer force-removes the sidecar container and then the volume; a second call is a no-op', async () => {
		const stub = stubDockerForViewer({ imagePresent: true });
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		await driver.startBrowserViewer({ runId: 'run-7', interactive: false });
		stub.calls.length = 0;

		await driver.stopBrowserViewer('run-7');
		expect(stub.calls).toEqual(['removeContainer', 'removeVolume']);
		expect(stub.container.remove).toHaveBeenCalledWith({ force: true });

		stub.calls.length = 0;
		await driver.stopBrowserViewer('run-7');
		expect(stub.calls).toEqual([]);
	});

	it('stopBrowserViewer retries a "volume is in use" rejection and treats a 404 as already gone, never rejecting', async () => {
		const stub = stubDockerForViewer({ imagePresent: true });
		stub.volumeRemove
			.mockRejectedValueOnce(Object.assign(new Error('volume is in use'), { statusCode: 409 }))
			.mockRejectedValueOnce(Object.assign(new Error('no such volume'), { statusCode: 404 }));
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		await driver.startBrowserViewer({ runId: 'run-8', interactive: false });

		await expect(driver.stopBrowserViewer('run-8')).resolves.toBeUndefined();
		expect(stub.volumeRemove).toHaveBeenCalledTimes(2);
	});

	it('stopBrowserViewer for a run that never started a viewer touches the daemon not at all', async () => {
		const stub = stubDockerForViewer();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		await driver.stopBrowserViewer('never-started');
		expect(stub.calls).toEqual([]);
	});
});

describe('DockerDriver.startRun - the X-socket volume mount', () => {
	it('mounts the given volume at /tmp/.X11-unix and changes nothing else about the container (no env, ports, or command)', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const outcomePromise = driver.startRun(
			{
				runId: 'run-bv-1',
				imageId: 'fake-image',
				env: { A: 'b' },
				memoryMbytes: 128,
				timeoutSecs: 60,
				x11SocketVolume: 'actor-runtime-x11-run-bv-1',
			},
			() => {},
		);
		await new Promise((resolve) => setImmediate(resolve));

		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.HostConfig?.Mounts).toEqual([
			{ Type: 'volume', Source: 'actor-runtime-x11-run-bv-1', Target: '/tmp/.X11-unix' },
		]);
		expect(options.Env).toEqual(['A=b']);
		expect(options.ExposedPorts).toBeUndefined();
		expect(options.HostConfig?.PortBindings).toBeUndefined();
		expect(options).not.toHaveProperty('Cmd');
		expect(options).not.toHaveProperty('Entrypoint');

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('composes with a devMount: both mounts land in one Mounts array', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		// The run-start dev-folder re-check (`assertDevFolderStillPresent`) is not under test here.
		vi.spyOn(driver, 'ensureProbeImage').mockResolvedValue('probe:image');
		vi.spyOn(driver, 'probeDevFolder').mockResolvedValue({ ok: true });

		const outcomePromise = driver.startRun(
			{
				runId: 'run-bv-2',
				imageId: 'fake-image',
				env: {},
				memoryMbytes: 128,
				timeoutSecs: 60,
				devMount: { localDevFolder: '/host/src', imageWorkingDirectory: '/usr/src/app' },
				x11SocketVolume: 'actor-runtime-x11-run-bv-2',
			},
			() => {},
		);
		await new Promise((resolve) => setImmediate(resolve));

		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.HostConfig?.Mounts).toEqual([
			{ Type: 'bind', Source: '/host/src', Target: '/usr/src/app' },
			{
				Type: 'volume',
				Source: expect.stringMatching(/^actor-runtime-node-modules-/),
				Target: '/usr/src/app/node_modules',
			},
			{ Type: 'volume', Source: 'actor-runtime-x11-run-bv-2', Target: '/tmp/.X11-unix' },
		]);

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});

	it('a run without a browser view carries no Mounts key at all (regression: byte-identical to before)', async () => {
		const stub = stubDockerForRun();
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const outcomePromise = driver.startRun(
			{ runId: 'run-bv-3', imageId: 'fake-image', env: {}, memoryMbytes: 128, timeoutSecs: 60 },
			() => {},
		);
		await new Promise((resolve) => setImmediate(resolve));

		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.HostConfig).not.toHaveProperty('Mounts');

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcomePromise;
	});
});
