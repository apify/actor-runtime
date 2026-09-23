/** `DockerDriver.startRun`'s standby surface: how a standby container's server is made reachable. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DockerDriver } from '../../src/driver/docker-driver.js';
import { stubDockerForRun } from './helpers/docker-stubs.js';

function stubWithInspect(info: Record<string, unknown>) {
	const stub = stubDockerForRun();
	Object.assign(stub.container, { inspect: vi.fn(async () => info) });
	return stub;
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('DockerDriver.startRun - containerServerPort', () => {
	const ORIGINAL_HOSTNAME = process.env.HOSTNAME;
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'actor-runtime-standby-driver-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		if (ORIGINAL_HOSTNAME === undefined) delete process.env.HOSTNAME;
		else process.env.HOSTNAME = ORIGINAL_HOSTNAME;
	});

	it('publishes nothing on apify-local and reaches the container at its network address', async () => {
		const stub = stubWithInspect({ NetworkSettings: { Networks: { 'apify-local': { IPAddress: '10.1.2.3' } } } });
		const driver = new DockerDriver(stub.docker);
		driver.available = true;
		(driver as unknown as { onActorNetwork: boolean }).onActorNetwork = true;

		const outcome = driver.startRun(
			{ runId: 'r1', imageId: 'img', env: {}, memoryMbytes: 128, timeoutSecs: 0, containerServerPort: 4321 },
			() => {},
		);
		await settle();

		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.ExposedPorts).toBeUndefined();
		expect(options.HostConfig?.PortBindings).toBeUndefined();
		expect(await driver.containerServerAddress('r1')).toEqual({ host: '10.1.2.3', port: 4321 });

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcome;
		expect(await driver.containerServerAddress('r1')).toBeUndefined();
	});

	it('from a process on the host itself, publishes the port on loopback at an engine-picked port', async () => {
		delete process.env.HOSTNAME;
		const stub = stubWithInspect({
			NetworkSettings: { Ports: { '4321/tcp': [{ HostIp: '127.0.0.1', HostPort: '49153' }] } },
		});
		const driver = new DockerDriver(stub.docker);
		driver.available = true;

		const outcome = driver.startRun(
			{ runId: 'r2', imageId: 'img', env: {}, memoryMbytes: 128, timeoutSecs: 0, containerServerPort: 4321 },
			() => {},
		);
		await settle();

		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.ExposedPorts).toEqual({ '4321/tcp': {} });
		expect(options.HostConfig?.PortBindings).toEqual({ '4321/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] });
		expect(await driver.containerServerAddress('r2')).toEqual({ host: '127.0.0.1', port: 49153 });

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcome;
	});

	it("from a container off apify-local, publishes on the host and reaches it at the engine's host address", async () => {
		process.env.HOSTNAME = 'self';
		const hostsFile = join(dir, 'hosts');
		writeFileSync(hostsFile, '127.0.0.1 localhost\n169.254.1.2 host.containers.internal\n');
		const stub = stubWithInspect({
			NetworkSettings: { Ports: { '4321/tcp': [{ HostIp: '0.0.0.0', HostPort: '40000' }] } },
		});
		const driver = new DockerDriver(stub.docker, { hostsFile });
		driver.available = true;

		const outcome = driver.startRun(
			{ runId: 'r3', imageId: 'img', env: {}, memoryMbytes: 128, timeoutSecs: 0, containerServerPort: 4321 },
			() => {},
		);
		await settle();

		const [options] = stub.createContainer.mock.calls[0]!;
		expect(options.HostConfig?.PortBindings).toEqual({ '4321/tcp': [{ HostIp: '', HostPort: '' }] });
		// The hosts file is read from disk, which outlasts a few event-loop turns.
		await vi.waitFor(async () =>
			expect(await driver.containerServerAddress('r3')).toEqual({ host: '169.254.1.2', port: 40000 }),
		);

		stub.triggerContainerExit(0);
		stub.endLogStream();
		await outcome;
	});

	it('arms no timeout for a run with timeoutSecs 0', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		try {
			const stub = stubWithInspect({});
			const driver = new DockerDriver(stub.docker);
			driver.available = true;
			const outcome = driver.startRun(
				{ runId: 'r4', imageId: 'img', env: {}, memoryMbytes: 128, timeoutSecs: 0 },
				() => {},
			);
			await settle();
			await vi.advanceTimersByTimeAsync(10 * 24 * 3600 * 1000);
			expect(stub.container.stop).not.toHaveBeenCalled();
			stub.triggerContainerExit(0);
			stub.endLogStream();
			await vi.advanceTimersByTimeAsync(10);
			expect((await outcome).timedOut).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
