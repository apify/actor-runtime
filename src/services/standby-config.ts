/**
 * An Actor's `actorStandby` settings (`actor-driver.md`'s "Actor Standby"): the platform's field set,
 * defaults and validation rules (apify-core's `ActorStandbySchema`), single-tenant only.
 */
import type { ActorRecord, ActorStandbyRecord, SourceFile } from '../storage/entities.js';
import { API_PORT } from '../config.js';
import { parseActorJson } from './actor-source-files.js';
import { DEFAULT_BUILD_TAG } from './actors.js';

export const STANDBY_DEFAULTS: ActorStandbyRecord = {
	isEnabled: false,
	disableStandbyFieldsOverride: false,
	tenancy: 'SINGLE_TENANT',
	desiredRequestsPerActorRun: 3,
	maxRequestsPerActorRun: 4,
	idleTimeoutSecs: 300,
	build: DEFAULT_BUILD_TAG,
	memoryMbytes: 1024,
	shouldPassActorInput: false,
};

const MIN_IDLE_TIMEOUT_SECS = 5;

/** Where a standby Actor is served: `/actor-runtime/standby/<label>/...` on the API port. */
export const STANDBY_PATH_PREFIX = '/actor-runtime/standby';

export type StandbyUpdateResult =
	{ kind: 'ok'; actorStandby: ActorStandbyRecord } | { kind: 'invalid'; message: string };

const BOOLEAN_FIELDS = ['isEnabled', 'disableStandbyFieldsOverride', 'shouldPassActorInput'] as const;
const INTEGER_FIELDS = [
	'desiredRequestsPerActorRun',
	'maxRequestsPerActorRun',
	'idleTimeoutSecs',
	'memoryMbytes',
] as const;
/** Accepted and dropped: the platform lets only admins set them. */
const ADMIN_ONLY_FIELDS = ['isConsoleAuthEnabled', 'isTokenlessEnabled'];

/**
 * Merges `raw` over `current` (itself over the defaults), as the platform does for both create and a
 * partial update, then validates the result.
 */
export function mergeStandbyUpdate(raw: unknown, current: ActorStandbyRecord | undefined): StandbyUpdateResult {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { kind: 'invalid', message: '"actorStandby" must be an object' };
	}
	const body = raw as Record<string, unknown>;
	const merged: ActorStandbyRecord = { ...STANDBY_DEFAULTS, ...current };

	for (const [key, value] of Object.entries(body)) {
		if (value === undefined || value === null) continue;
		if ((BOOLEAN_FIELDS as readonly string[]).includes(key)) {
			if (typeof value !== 'boolean')
				return { kind: 'invalid', message: `actorStandby.${key} must be a boolean` };
			merged[key as (typeof BOOLEAN_FIELDS)[number]] = value;
		} else if ((INTEGER_FIELDS as readonly string[]).includes(key)) {
			if (typeof value !== 'number' || !Number.isInteger(value)) {
				return { kind: 'invalid', message: `actorStandby.${key} must be an integer` };
			}
			merged[key as (typeof INTEGER_FIELDS)[number]] = value;
		} else if (key === 'build') {
			if (typeof value !== 'string' || value.trim() === '') {
				return { kind: 'invalid', message: 'actorStandby.build must be a build tag or build number' };
			}
			merged.build = value;
		} else if (key === 'tenancy') {
			if (value !== 'SINGLE_TENANT') {
				return { kind: 'invalid', message: 'Only SINGLE_TENANT Actor Standby is supported by this runtime' };
			}
		} else if (!ADMIN_ONLY_FIELDS.includes(key)) {
			return { kind: 'invalid', message: `Unknown field actorStandby.${key}` };
		}
	}

	if (merged.desiredRequestsPerActorRun < 1) {
		return { kind: 'invalid', message: 'actorStandby.desiredRequestsPerActorRun must be >= 1' };
	}
	if (merged.maxRequestsPerActorRun < 1) {
		return { kind: 'invalid', message: 'actorStandby.maxRequestsPerActorRun must be >= 1' };
	}
	if (merged.maxRequestsPerActorRun < merged.desiredRequestsPerActorRun) {
		return { kind: 'invalid', message: 'Max requests must be greater than or equal to desired requests.' };
	}
	if (merged.idleTimeoutSecs < MIN_IDLE_TIMEOUT_SECS) {
		return { kind: 'invalid', message: `actorStandby.idleTimeoutSecs must be >= ${MIN_IDLE_TIMEOUT_SECS}` };
	}
	if (merged.memoryMbytes < 1) return { kind: 'invalid', message: 'actorStandby.memoryMbytes must be >= 1' };
	return { kind: 'ok', actorStandby: merged };
}

/** `usesStandbyMode: true` in the pushed `.actor/actor.json`; an unparseable file says nothing. */
export function declaresStandbyMode(sourceFiles: SourceFile[]): boolean {
	const parsed = parseActorJson(sourceFiles);
	if (parsed.outcome !== 'parsed') return false;
	const specification = parsed.specification as { usesStandbyMode?: unknown } | null;
	return typeof specification === 'object' && specification !== null && specification.usesStandbyMode === true;
}

/** The platform's `dnsFriendlyUsername`: what a DNS label can carry. */
function dnsFriendly(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** The platform's `<username>--<actor-name>` hostname label. */
export function standbyLabel(actor: ActorRecord, username: string): string {
	return `${dnsFriendly(username)}--${actor.name.toLowerCase()}`;
}

/** Host-facing: the runtime's own API port, which is what every client of the Actor reaches. */
export function standbyUrl(actor: ActorRecord, username: string): string {
	return `http://localhost:${API_PORT}${STANDBY_PATH_PREFIX}/${standbyLabel(actor, username)}`;
}

/** The label, or `undefined` for a Host header not of the `<label>.localhost` form. */
export function labelFromHost(host: string | undefined): string | undefined {
	const match = host?.toLowerCase().match(/^([a-z0-9-]+)\.localhost(?::\d+)?$/);
	return match?.[1];
}
