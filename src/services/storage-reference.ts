/**
 * Parsing of the `:datasetId` / `:storeId` / `:queueId` path segment into the forms the real Apify API
 * accepts (`api.md`'s "Storage id encoding") - a transcription of apify-core's `parseResourceName`
 * (`packages/utils/src/conversion.ts`) plus the owner rules its `ResourceIdGetter` middleware layers on
 * top, so a reference means the same thing here as on the platform:
 *
 *  - no separator at all -> the whole segment is an **id**, never a name (`GET /v2/datasets/my-dataset`
 *    is a lookup for a storage *id* `my-dataset` on the platform too - unlike `:actorId`, which the
 *    platform and `services/actors.ts: resolveOwnedActor` both also accept as a bare name);
 *  - `<prefix>~<name>` (or `<prefix>/<name>` - `/` is the platform's canonical separator, apify-client
 *    rewrites it to `~` before sending because it cannot travel in a path segment; accepted here for
 *    parity when it arrives percent-encoded) -> a **named** reference, where the prefix is
 *      - empty (`~name`): the caller's own storage,
 *      - 17 alphanumeric characters: a user **id** - the platform forbids usernames of that shape
 *        precisely so this is unambiguous,
 *      - anything else: a **username**;
 *  - an empty name (`username~`, `~`) is the platform's `400 invalid-request` "Resource name parameter
 *    cannot be empty", surfaced as `kind: 'empty-name'` for the API layer to turn into that error.
 *
 * Pure: no registry access, no ownership decision - `services/storages.ts: resolveOwnedStorage` does that.
 *
 * One deliberate difference: apify-core keeps only the segment *between* the first two separators
 * (`[usernameOrId, name] = maybeId.split('~')`), this parser keeps everything after the first one. No
 * valid platform storage name contains either separator, so no reference the platform resolves is
 * ever read differently here; the runtime itself does not validate names, so a locally-created
 * `na~me` stays reachable as `~na~me`.
 */

/** The platform's separator inside `username/name` - what `apify-client-js` rewrites to `~`. */
const CANONICAL_SEPARATOR = '/';
/** The URL-safe separator every client actually sends. */
const URL_SEPARATOR = '~';

/** Same shape `storage/ids.ts: generateId` produces and the platform's own `APIFY_ID_REGEX` enforces. */
const APIFY_ID_REGEX = /^[a-zA-Z0-9]{17}$/;

export type StorageOwnerReference =
	{ by: 'self' } | { by: 'userId'; userId: string } | { by: 'username'; username: string };

export type StorageReference =
	{ kind: 'id'; id: string } | { kind: 'named'; owner: StorageOwnerReference; name: string } | { kind: 'empty-name' };

export function parseStorageReference(maybeId: string): StorageReference {
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
