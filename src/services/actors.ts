import { generateId } from '../storage/ids.js';
import type { ActorRecord, ActorVersionRecord, UserRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import { isCallerOwner, normalizeName, type ResolvableReference } from './resource-reference.js';

/** The tag a build/run resolves to when the caller names none. `api/routes/actors.ts` and
 * `services/runs.ts` both import this instead of declaring their own `'latest'` literal. */
export const DEFAULT_BUILD_TAG = 'latest';

export interface CreateActorInput {
	name: string;
	title?: string;
	versions?: ActorVersionRecord[];
}

export async function createActor(userId: string, input: CreateActorInput): Promise<ActorRecord> {
	const now = new Date().toISOString();
	const record: ActorRecord = {
		id: generateId(),
		userId,
		name: input.name,
		title: input.title,
		createdAt: now,
		modifiedAt: now,
		versions: input.versions ?? [],
		taggedBuilds: {},
	};
	await getRegistries().actors.set(record.id, record);
	return record;
}

export async function listOwnedActors(userId: string): Promise<ActorRecord[]> {
	const all = await getRegistries().actors.list();
	return all.filter((actor) => actor.userId === userId);
}

export async function getOwnedActor(userId: string, id: string): Promise<ActorRecord | null> {
	const record = await getRegistries().actors.get(id);
	if (!record || record.userId !== userId) return null;
	return record;
}

/**
 * Cross-user listing, for the console only (`console.md`: the console is an unauthenticated local dev
 * tool with no login of its own, and every route is a read except the dev-folder registration form, so
 * with multiple users it shows every user's objects rather than scoping to one - see
 * `console/server.ts`). The API's own `listOwnedActors` above stays strictly per-user; nothing here is
 * reachable from `api/routes/*`.
 */
export async function listAllActors(): Promise<ActorRecord[]> {
	return getRegistries().actors.list();
}

/** Cross-user lookup by id, for the console only (see `listAllActors`) - no ownership check, since the
 * console's detail pages show any user's object. */
export async function getActorById(id: string): Promise<ActorRecord | null> {
	return getRegistries().actors.get(id);
}

/** Case-insensitive, like the platform's `nameLowerCase` (`normalizeName`), and shared by both forms
 * `resolveOwnedActor` accepts below. */
export async function findOwnedActorByName(userId: string, name: string): Promise<ActorRecord | null> {
	const wanted = normalizeName(name);
	const owned = await listOwnedActors(userId);
	return owned.find((actor) => normalizeName(actor.name) === wanted) ?? null;
}

/**
 * Resolves a parsed `:actorId` reference (`services/resource-reference.ts`) to the caller's Actor, or
 * `null` - the API layer's `record-not-found`. The named forms (`~name`, `username~name`,
 * `userId~name`) work exactly as they do for storages, under the same restricted view
 * (`isCallerOwner`).
 *
 * The one Actor-specific rule, and the only place this differs from `resolveOwnedStorage`: a bare
 * segment with no separator is tried as an id **and then as a name**, because the platform accepts a
 * plain Actor name there too - which is how stock `apify push` finds an existing Actor by name before
 * an id has ever been minted.
 */
export async function resolveOwnedActor(user: UserRecord, reference: ResolvableReference): Promise<ActorRecord | null> {
	if (reference.kind === 'id') {
		return (await getOwnedActor(user.id, reference.id)) ?? findOwnedActorByName(user.id, reference.id);
	}
	if (!isCallerOwner(user, reference.owner)) return null;
	return findOwnedActorByName(user.id, reference.name);
}

export async function updateActor(
	id: string,
	mutator: (current: ActorRecord) => ActorRecord,
): Promise<ActorRecord | null> {
	return getRegistries().actors.update(id, (current) => {
		if (!current) return null;
		return { ...mutator(current), modifiedAt: new Date().toISOString() };
	});
}

export async function deleteActor(id: string): Promise<void> {
	await getRegistries().actors.delete(id);
}

export function addOrReplaceVersion(actor: ActorRecord, version: ActorVersionRecord): ActorRecord {
	const versions = actor.versions.filter((v) => v.versionNumber !== version.versionNumber);
	versions.push(version);
	return { ...actor, versions };
}

export function findVersion(actor: ActorRecord, versionNumber: string): ActorVersionRecord | undefined {
	return actor.versions.find((v) => v.versionNumber === versionNumber);
}

/** Record a successful build against its tag - stock `apify push` polls `taggedBuilds[<tag>]`. */
export function recordTaggedBuild(actor: ActorRecord, tag: string, buildId: string, buildNumber: string): ActorRecord {
	return { ...actor, taggedBuilds: { ...actor.taggedBuilds, [tag]: { buildId, buildNumber } } };
}
