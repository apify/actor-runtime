import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';

import {
	STANDBY_DEFAULTS,
	declaresStandbyMode,
	labelFromHost,
	mergeStandbyUpdate,
	standbyLabel,
	standbyUrl,
	standbyUrlAudienceOf,
} from '../../src/services/standby-config.js';
import { standbyTargetOf } from '../../src/api/standby-proxy.js';
import type { ActorRecord } from '../../src/storage/entities.js';

describe('mergeStandbyUpdate', () => {
	it('fills the platform defaults under a partial body, and keeps stored values under a later one', () => {
		const created = mergeStandbyUpdate({ isEnabled: true }, undefined);
		expect(created).toEqual({ kind: 'ok', actorStandby: { ...STANDBY_DEFAULTS, isEnabled: true } });
		const updated = mergeStandbyUpdate(
			{ memoryMbytes: 256, build: '0.1' },
			created.kind === 'ok' ? created.actorStandby : undefined,
		);
		expect(updated).toMatchObject({
			kind: 'ok',
			actorStandby: { isEnabled: true, memoryMbytes: 256, build: '0.1' },
		});
	});

	it('accepts desired == max and drops the admin-only fields', () => {
		const result = mergeStandbyUpdate(
			{ desiredRequestsPerActorRun: 4, maxRequestsPerActorRun: 4, isTokenlessEnabled: true },
			undefined,
		);
		expect(result.kind).toBe('ok');
		expect(result.kind === 'ok' && 'isTokenlessEnabled' in result.actorStandby).toBe(false);
	});

	it.each([
		[[], '"actorStandby" must be an object'],
		[{ maxRequestsPerActorRun: 2 }, 'Max requests must be greater than or equal to desired requests.'],
		[{ desiredRequestsPerActorRun: 0 }, 'actorStandby.desiredRequestsPerActorRun must be >= 1'],
		[{ idleTimeoutSecs: 4 }, 'actorStandby.idleTimeoutSecs must be >= 5'],
		[{ idleTimeoutSecs: 5.5 }, 'actorStandby.idleTimeoutSecs must be an integer'],
		[{ build: '' }, 'actorStandby.build must be a build tag or build number'],
		[{ tenancy: 'MULTI_TENANT' }, 'Only SINGLE_TENANT Actor Standby is supported by this runtime'],
		[{ foo: 1 }, 'Unknown field actorStandby.foo'],
	])('rejects %j', (body, message) => {
		expect(mergeStandbyUpdate(body, undefined)).toEqual({ kind: 'invalid', message });
	});
});

describe('declaresStandbyMode', () => {
	const file = (content: string) => [{ name: '.actor/actor.json', format: 'TEXT' as const, content }];
	it('reads usesStandbyMode from .actor/actor.json, JSON5 included', () => {
		expect(declaresStandbyMode(file('{ usesStandbyMode: true }'))).toBe(true);
		expect(declaresStandbyMode(file('{ "usesStandbyMode": false }'))).toBe(false);
		expect(declaresStandbyMode(file('{ not json'))).toBe(false);
		expect(declaresStandbyMode([])).toBe(false);
	});
});

describe('standby addressing', () => {
	const actor = { name: 'My-Actor' } as ActorRecord;

	it("builds the platform's <username>--<name> label, DNS-safe", () => {
		expect(standbyLabel(actor, 'john.doe')).toBe('john-doe--my-actor');
	});

	it('builds the host-facing standbyUrl in the platform shape, and the container one on the API alias', () => {
		const actor = { name: 'My-Actor' } as ActorRecord;
		expect(standbyUrl(actor, 'John.Doe')).toBe('http://john-doe--my-actor.localhost:3333');
		expect(standbyUrl(actor, 'John.Doe', 'container')).toBe(
			'http://apify-api:3333/actor-runtime/standby/john-doe--my-actor',
		);
		expect(standbyUrlAudienceOf('apify-api:3333')).toBe('container');
		expect(standbyUrlAudienceOf('localhost:3333')).toBe('host');
		expect(standbyUrlAudienceOf(undefined)).toBe('host');
	});

	it('reads a label only from a <label>.localhost host', () => {
		expect(labelFromHost('john-doe--my-actor.localhost:3333')).toBe('john-doe--my-actor');
		expect(labelFromHost('localhost:3333')).toBeUndefined();
		expect(labelFromHost('apify-api:3333')).toBeUndefined();
		expect(labelFromHost(undefined)).toBeUndefined();
	});

	const req = (url: string, host = 'localhost:3333') => ({ url, headers: { host } }) as unknown as IncomingMessage;

	it.each([
		['/actor-runtime/standby/a--b', { label: 'a--b', forwardPath: '/' }],
		['/actor-runtime/standby/a--b/', { label: 'a--b', forwardPath: '/' }],
		['/actor-runtime/standby/A--B/mcp?x=1', { label: 'a--b', forwardPath: '/mcp?x=1' }],
		['/actor-runtime/standby/a--b?token=t', { label: 'a--b', forwardPath: '/?token=t' }],
		['/actor-runtime/standby/', undefined],
		['/actor-runtime/standbyx/a', undefined],
		['/v2/actors', undefined],
	])('maps %s', (url, expected) => {
		expect(standbyTargetOf(req(url))).toEqual(expected);
	});

	it('forwards the whole path of a host-addressed request', () => {
		expect(standbyTargetOf(req('/v2/anything?q=1', 'a--b.localhost:3333'))).toEqual({
			label: 'a--b',
			forwardPath: '/v2/anything?q=1',
		});
	});
});
