/**
 * Parsing of the `:actorId` / `:datasetId` / `:storeId` / `:queueId` path segment into the forms the
 * real Apify API accepts (`api.md`'s "Resource id encoding") - a transcription of apify-core's
 * `parseResourceName` (`packages/utils/src/conversion.ts`) plus the owner rules its `ResourceIdGetter`
 * middleware layers on top, so a reference means the same thing here as on the platform. One parser for
 * Actors and storages alike: they differ only in whether a bare segment can also be a name (see
 * `services/actors.ts: resolveOwnedActor`).
 *
 *  - no separator at all -> the whole segment is an **id**;
 *  - `<prefix>~<name>` (or `<prefix>/<name>` - `/` is the platform's canonical separator, apify-client
 *    rewrites it to `~` before sending because it cannot travel in a path segment; accepted here for
 *    parity when it arrives percent-encoded) -> a **named** reference, where the prefix is
 *      - empty (`~name`): the caller's own resource,
 *      - 17 alphanumeric characters: a user **id** - the platform forbids usernames of that shape
 *        precisely so this is unambiguous,
 *      - anything else: a **username**;
 *  - an empty name (`username~`, `~`) is the platform's `400 invalid-request` "Resource name parameter
 *    cannot be empty", surfaced as `kind: 'empty-name'` for the API layer to turn into that error.
 *
 * Pure: no registry access, no ownership decision - `isCallerOwner` below is the one rule both
 * `resolveOwnedActor` and `resolveOwnedStorage` apply to a parsed owner.
 *
 * One deliberate difference: apify-core keeps only the segment *between* the first two separators
 * (`[usernameOrId, name] = maybeId.split('~')`), this parser keeps everything after the first one. No
 * valid platform name contains either separator, so no reference the platform resolves is ever read
 * differently here; the runtime itself does not validate names, so a locally-created `na~me` stays
 * reachable as `~na~me`.
 */
import type { UserRecord } from '../storage/entities.js';

/** The platform's separator inside `username/name` - what `apify-client-js` rewrites to `~`. */
const CANONICAL_SEPARATOR = '/';
/** The URL-safe separator every client actually sends. */
const URL_SEPARATOR = '~';

/** Same shape `storage/ids.ts: generateId` produces and the platform's own `APIFY_ID_REGEX` enforces. */
const APIFY_ID_REGEX = /^[a-zA-Z0-9]{17}$/;

export type ResourceOwnerReference =
	{ by: 'self' } | { by: 'userId'; userId: string } | { by: 'username'; username: string };

export type ResourceReference =
	| { kind: 'id'; id: string }
	| { kind: 'named'; owner: ResourceOwnerReference; name: string }
	| { kind: 'empty-name' };

/** A reference that can actually be looked up - what the API layer hands the services once it has
 * turned `empty-name` into its `400 invalid-request` (`api/resolve-reference.ts`). */
export type ResolvableReference = Exclude<ResourceReference, { kind: 'empty-name' }>;

export function parseResourceReference(maybeId: string): ResourceReference {
	// `/` is checked before `~`, exactly like apify-core: `a~b/c` is user `a~b`, name `c`, on both.
	const separator = maybeId.includes(CANONICAL_SEPARATOR)
		? CANONICAL_SEPARATOR
		: maybeId.includes(URL_SEPARATOR)
			? URL_SEPARATOR
			: null;
	if (separator === null) return { kind: 'id', id: maybeId };

	const at = maybeId.indexOf(separator);
	const prefix = maybeId.slice(0, at);
	const name = maybeId.slice(at + 1);
	if (name === '') return { kind: 'empty-name' };

	if (prefix === '') return { kind: 'named', owner: { by: 'self' }, name };
	if (APIFY_ID_REGEX.test(prefix)) return { kind: 'named', owner: { by: 'userId', userId: prefix }, name };
	return { kind: 'named', owner: { by: 'username', username: prefix }, name };
}

/**
 * Whether a parsed owner is the calling user - the one place the restricted view (`storage.md`'s Users
 * section) is decided for a named reference, shared by Actors and storages.
 *
 * Every API response contains only the caller's own resources, so an owner that is not the caller -
 * another local user's username or id, a username nobody here has, the platform's `apify~...` - is
 * `false` without any registry access at all: it can never name a resource the caller may see, exactly
 * the outcome a real multi-user platform gives for someone else's private resource. The caller's own
 * lookup then decides the rest, and a `null` from it is what hands such a reference to the
 * `fallbackNotFoundEnabled` upstream relay (`services/api-fallback.ts`) unchanged.
 */
export function isCallerOwner(user: UserRecord, owner: ResourceOwnerReference): boolean {
	switch (owner.by) {
		case 'self':
			return true;
		case 'userId':
			return owner.userId === user.id;
		case 'username':
			return normalizeName(owner.username) === normalizeName(user.username);
	}
}

/** The one place a name is normalised for comparison - the platform keeps a `nameLowerCase` next to
 * every Actor's and storage's `name`, and both its uniqueness index and its `username~name` lookup use
 * that, never the display casing (apify-core's `ResourceIdGetter.getResourceIdFromName`). */
export function normalizeName(name: string): string {
	return name.toLowerCase();
}
