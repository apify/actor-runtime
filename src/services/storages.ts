/**
 * Ownership-filtered domain layer over the three user-facing storage types, shared by the API and the
 * console. All data access goes through the `Dataset` / `KeyValueStore` / `RequestQueue` frontends
 * (via `storage/open.ts`); `__STORAGES__` is the only place ownership, display name and timestamps
 * live, because `KeyValueStore` has no `getInfo()` of its own.
 */
import { generateId } from '../storage/ids.js';
import type { StorageRecord, StorageType, UserRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import { openDataset, openKeyValueStore, openRequestQueue } from '../storage/open.js';
import { closeRequestQueueBuffer } from '../storage/request-queue/registry.js';
import { KeyedMutex } from '../storage/mutex.js';
import type { StorageOwnerReference, StorageReference } from './storage-reference.js';

/**
 * Serialises the lookup-then-create critical section in `createStorage` per `user:type:name`, so two
 * concurrent `getOrCreate(name)` calls can never both pass the "not found" check before either has
 * written its record. Unnamed creates never look anything up (a fresh id can never collide), so they
 * skip the mutex entirely. Keyed by the *lower-cased* name, since that is what `findOwnedStorageByName`
 * matches on - `Foo` and `foo` are the same critical section, not two.
 */
const createByNameMutex = new KeyedMutex();

/** The one place a storage name is normalised for comparison - the platform keeps a `nameLowerCase`
 * next to every storage's `name` and both its uniqueness index and its `username~name` lookup use
 * that, never the display casing (apify-core's `ResourceIdGetter.getResourceIdFromName`). */
function normalizeName(name: string): string {
	return name.toLowerCase();
}

/**
 * Idempotent by `name`, matching apify-client-js's `getOrCreate(name)` contract: a bare
 * `POST .../datasets?name=X` relies on the *server* deduplicating by name (the client itself does no
 * dedup - `resource_collection_client.ts:41-49`). When `name` is given and a storage of this type with
 * that name already exists for the user - compared case-insensitively, the platform's own uniqueness
 * rule (`normalizeName`) - that existing record is returned unchanged, with its original casing, rather
 * than minting a new storage. The lookup-plus-create is serialised per `user:type:name` (see
 * `createByNameMutex`) so two concurrent calls with the same name can never both mint a record.
 */
export async function createStorage(userId: string, type: StorageType, name?: string): Promise<StorageRecord> {
	if (name) {
		return createByNameMutex.run(`${userId}:${type}:${normalizeName(name)}`, () =>
			createStorageRecord(userId, type, name),
		);
	}
	return createStorageRecord(userId, type, undefined);
}

async function createStorageRecord(
	userId: string,
	type: StorageType,
	name: string | undefined,
): Promise<StorageRecord> {
	if (name) {
		const existing = await findOwnedStorageByName(userId, type, name);
		if (existing) return existing;
	}

	const id = generateId();
	const now = new Date().toISOString();

	// Opening as a side effect materialises the Crawlee storage on disk immediately, named by id.
	if (type === 'dataset') await openDataset(id);
	else if (type === 'keyValueStore') await openKeyValueStore(id);
	else await openRequestQueue(id);

	const record: StorageRecord = { id, type, userId, name, createdAt: now, modifiedAt: now, accessedAt: now };
	await getRegistries().storages.set(id, record);
	return record;
}

export async function getOwnedStorage(userId: string, id: string, type: StorageType): Promise<StorageRecord | null> {
	const record = await getRegistries().storages.get(id);
	if (!record || record.userId !== userId || record.type !== type) return null;
	return record;
}

export async function listOwnedStorages(userId: string, type: StorageType): Promise<StorageRecord[]> {
	const all = await getRegistries().storages.list();
	return all.filter((s) => s.userId === userId && s.type === type);
}

/** Cross-user listing, for the console only (see `services/actors.ts: listAllActors`'s doc comment). */
export async function listAllStorages(type: StorageType): Promise<StorageRecord[]> {
	const all = await getRegistries().storages.list();
	return all.filter((s) => s.type === type);
}

/** Cross-user lookup by id, for the console only (see `listAllStorages`). */
export async function getStorageById(id: string, type: StorageType): Promise<StorageRecord | null> {
	const record = await getRegistries().storages.get(id);
	if (!record || record.type !== type) return null;
	return record;
}

/** Case-insensitive, like the platform (`normalizeName`): `~My-Store` and `~my-store` are the same
 * storage, and `getOrCreate('My-Store')` after `getOrCreate('my-store')` returns the existing one. */
export async function findOwnedStorageByName(
	userId: string,
	type: StorageType,
	name: string,
): Promise<StorageRecord | null> {
	const wanted = normalizeName(name);
	const owned = await listOwnedStorages(userId, type);
	return owned.find((s) => s.name !== undefined && normalizeName(s.name) === wanted) ?? null;
}

/**
 * Resolves a parsed `:datasetId`/`:storeId`/`:queueId` reference (`services/storage-reference.ts`) to
 * the caller's storage record, or `null` - the API layer's `record-not-found`. An id reference is
 * `getOwnedStorage`; a named one is `findOwnedStorageByName` under the owner the reference names,
 * with the platform's owner rules (apify-core's `ResourceIdGetter`): `~name` is the caller, a 17-char
 * alphanumeric prefix is a user id, anything else a username matched case-insensitively.
 *
 * Every API response is a restricted view of the caller's own resources (`storage.md`'s Users section),
 * so an owner that is not the caller - another local user's username or id, a username nobody here
 * has, the platform's `apify~...` - resolves to `null` without any registry access at all: it can never
 * name a storage the caller may see, exactly the outcome a real multi-user platform gives for someone
 * else's private storage. That `null` is also what hands such a reference to the `fallbackNotFoundEnabled`
 * upstream relay (`services/api-fallback.ts`) unchanged, where the platform decides what `apify~name`
 * means for the caller's real token - public storages included. Nothing here ever reads another user's
 * storages to answer the caller.
 */
export async function resolveOwnedStorage(
	user: UserRecord,
	reference: Exclude<StorageReference, { kind: 'empty-name' }>,
	type: StorageType,
): Promise<StorageRecord | null> {
	if (reference.kind === 'id') return getOwnedStorage(user.id, reference.id, type);
	if (!isCaller(user, reference.owner)) return null;
	return findOwnedStorageByName(user.id, type, reference.name);
}

function isCaller(user: UserRecord, owner: StorageOwnerReference): boolean {
	switch (owner.by) {
		case 'self':
			return true;
		case 'userId':
			return owner.userId === user.id;
		case 'username':
			return owner.username.toLowerCase() === user.username.toLowerCase();
	}
}

export async function touchStorage(id: string): Promise<void> {
	await getRegistries().storages.update(id, (current) => {
		if (!current) return null;
		return { ...current, accessedAt: new Date().toISOString() };
	});
}

export async function renameStorage(id: string, name: string): Promise<StorageRecord | null> {
	return getRegistries().storages.update(id, (current) => {
		if (!current) return null;
		return { ...current, name, modifiedAt: new Date().toISOString() };
	});
}

export async function dropStorage(record: StorageRecord): Promise<void> {
	if (record.type === 'dataset') {
		const dataset = await openDataset(record.id);
		await dataset.drop();
	} else if (record.type === 'keyValueStore') {
		const store = await openKeyValueStore(record.id);
		await store.drop();
	} else {
		closeRequestQueueBuffer(record.id);
		const queue = await openRequestQueue(record.id);
		await queue.drop();
	}
	await getRegistries().storages.delete(record.id);
}
