/**
 * One parser for the `:actorId` / `:datasetId` / `:storeId` / `:queueId` segment, mirroring apify-core's
 * `parseResourceName` (`packages/utils/src/conversion.ts`) and the owner rules its `ResourceIdGetter`
 * middleware adds on top, so a reference means the same thing here as on the platform (`api.md`'s
 * "Resource id encoding").
 *
 * Deliberate divergence: apify-core keeps only the segment between the first two separators, this keeps
 * everything after the first one. No valid platform name contains a separator, so nothing the platform
 * resolves reads differently here, and a locally-created `na~me` stays reachable as `~na~me`.
 */
import type { UserRecord } from '../storage/entities.js';

/** The platform's canonical separator; apify-client rewrites it to `~`, which a path segment can carry. */
const CANONICAL_SEPARATOR = '/';
const URL_SEPARATOR = '~';

/** A prefix of this shape is a user id, never a username - the platform forbids id-shaped usernames. */
const APIFY_ID_REGEX = /^[a-zA-Z0-9]{17}$/;

export type ResourceOwnerReference =
	{ by: 'self' } | { by: 'userId'; userId: string } | { by: 'username'; username: string };

export type ResourceReference =
	| { kind: 'id'; id: string }
	| { kind: 'named'; owner: ResourceOwnerReference; name: string }
	| { kind: 'empty-name' };

/** What the API layer hands the services, once it has turned `empty-name` into `400 invalid-request`. */
export type ResolvableReference = Exclude<ResourceReference, { kind: 'empty-name' }>;

export function parseResourceReference(maybeId: string): ResourceReference {
	// `/` before `~`, like apify-core: `a~b/c` is user `a~b`, name `c`, on both.
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
 * Every API response is a restricted view of the caller's own resources (`storage.md`), so any other
 * owner is refused without touching the registry - the runtime never reads another user's records to
 * answer a caller. The `record-not-found` that follows is also what lets the upstream fallback try the
 * same reference against the real platform.
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

/** The platform compares through a stored `nameLowerCase`, never the display casing. */
export function normalizeName(name: string): string {
	return name.toLowerCase();
}
