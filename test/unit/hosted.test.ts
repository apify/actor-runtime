import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostedAuth, TOKEN_COOKIE } from '../../src/hosted/auth.js';
import { createHostedServer, isApiPath } from '../../src/hosted/server.js';
import { isHostedMode } from '../../src/config.js';

const OWNER = 'owner-id';

function fakeApp(label: string) {
	return ((_req: unknown, res: { end(body: string): void }) => res.end(label)) as never;
}

function authFor(owners: Record<string, string>) {
	const fetchFn = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
		const token = init?.headers?.authorization?.slice('Bearer '.length) ?? '';
		const id = owners[token];
		return new Response(id ? JSON.stringify({ data: { id } }) : '{}', { status: id ? 200 : 401 });
	});
	return {
		auth: new HostedAuth({ ownerId: OWNER, apiBaseUrl: 'https://api.test', fetchFn: fetchFn as never }),
		fetchFn,
	};
}

let server: Server | undefined;
afterEach(() => server?.close());

async function start(owners: Record<string, string>) {
	const { auth, fetchFn } = authFor(owners);
	server = createHostedServer({ apiApp: fakeApp('api'), consoleApp: fakeApp('console'), auth });
	await new Promise<void>((resolve) => server!.listen(0, resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { base, fetchFn };
}

describe('isHostedMode', () => {
	it('is on for a standby run on the platform, or when forced', () => {
		expect(isHostedMode({ APIFY_IS_AT_HOME: '1', ACTOR_STANDBY_PORT: '4321' })).toBe(true);
		expect(isHostedMode({ ACTOR_RUNTIME_HOSTED: '1' })).toBe(true);
		expect(isHostedMode({ ACTOR_STANDBY_PORT: '4321' })).toBe(false);
		expect(isHostedMode({})).toBe(false);
	});
});

describe('isApiPath', () => {
	it.each(['/v2/users/me', '/actor-runtime/skill', '/v2'])('%s is the API', (path) => {
		expect(isApiPath(path)).toBe(true);
	});
	it.each(['/', '/actors', '/runs/1/browser', '/v2x', '/actor-runtimes'])('%s is the console', (path) => {
		expect(isApiPath(path)).toBe(false);
	});
});

describe('hosted server', () => {
	it('answers the readiness probe without a token', async () => {
		const { base } = await start({});
		const response = await fetch(`${base}/`, { headers: { 'x-apify-container-server-readiness-probe': '1' } });
		expect(response.status).toBe(200);
	});

	it('rejects a missing token and a token of another account', async () => {
		const { base } = await start({ other: 'someone-else' });
		expect((await fetch(`${base}/v2/users/me`)).status).toBe(401);
		const other = await fetch(`${base}/v2/users/me`, { headers: { authorization: 'Bearer other' } });
		expect(other.status).toBe(403);
	});

	it('routes the owner to the API by path and to the console otherwise', async () => {
		const { base, fetchFn } = await start({ good: OWNER });
		const headers = { authorization: 'Bearer good' };
		expect(await (await fetch(`${base}/v2/actors`, { headers })).text()).toBe('api');
		expect(await (await fetch(`${base}/actors`, { headers })).text()).toBe('console');
		// The verdict is cached across requests.
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it('swaps a console ?token= for a cookie, and honours the cookie only off the API', async () => {
		const { base } = await start({ good: OWNER });
		const first = await fetch(`${base}/actors?token=good&x=1`, { redirect: 'manual' });
		expect(first.status).toBe(302);
		expect(first.headers.get('location')).toBe('/actors?x=1');
		expect(first.headers.get('set-cookie')).toContain(`${TOKEN_COOKIE}=good`);
		const cookie = { cookie: `${TOKEN_COOKIE}=good` };
		expect(await (await fetch(`${base}/actors`, { headers: cookie })).text()).toBe('console');
		expect((await fetch(`${base}/v2/actors`, { headers: cookie })).status).toBe(401);
	});

	it('leaves the skill public', async () => {
		const { base } = await start({});
		expect(await (await fetch(`${base}/actor-runtime/skill`)).text()).toBe('api');
	});
});
