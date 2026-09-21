/**
 * `services/storage-reference.ts: parseStorageReference` against the platform's own rules
 * (apify-core's `parseResourceName` + `ResourceIdGetter`, `api.md`'s "Storage id encoding") - every
 * form a `:datasetId`/`:storeId`/`:queueId` segment can take, and what each one means.
 */
import { describe, expect, it } from 'vitest';

import { parseStorageReference } from '../../src/services/storage-reference.js';

describe('parseStorageReference', () => {
	it('a segment without a separator is an id - never a bare name, unlike :actorId', () => {
		expect(parseStorageReference('WkzbQMuFYuamGv3YF')).toEqual({ kind: 'id', id: 'WkzbQMuFYuamGv3YF' });
		expect(parseStorageReference('my-dataset')).toEqual({ kind: 'id', id: 'my-dataset' });
		expect(parseStorageReference('')).toEqual({ kind: 'id', id: '' });
	});

	it("`~name` (empty prefix) is the caller's own named storage", () => {
		expect(parseStorageReference('~my-dataset')).toEqual({
			kind: 'named',
			owner: { by: 'self' },
			name: 'my-dataset',
		});
	});

	it('`username~name` names another user by username', () => {
		expect(parseStorageReference('apify~web-scraper-results')).toEqual({
			kind: 'named',
			owner: { by: 'username', username: 'apify' },
			name: 'web-scraper-results',
		});
		// Casing is preserved here - `resolveOwnedStorage` is what compares case-insensitively.
		expect(parseStorageReference('Local-User-1~My-Store')).toEqual({
			kind: 'named',
			owner: { by: 'username', username: 'Local-User-1' },
			name: 'My-Store',
		});
	});

	it('a 17-character alphanumeric prefix is a user id, not a username - the platform forbids usernames of that shape', () => {
		expect(parseStorageReference('WkzbQMuFYuamGv3YF~my-dataset')).toEqual({
			kind: 'named',
			owner: { by: 'userId', userId: 'WkzbQMuFYuamGv3YF' },
			name: 'my-dataset',
		});
		// This runtime's own fabricated user ids (`0000000000000000{n}`) are 17 alphanumerics too.
		expect(parseStorageReference('00000000000000001~my-dataset')).toEqual({
			kind: 'named',
			owner: { by: 'userId', userId: '00000000000000001' },
			name: 'my-dataset',
		});
		// 16 or 18 characters, or a non-alphanumeric character, is a username.
		expect(parseStorageReference('WkzbQMuFYuamGv3Y~x').owner).toEqual({
			by: 'username',
			username: 'WkzbQMuFYuamGv3Y',
		});
		expect(parseStorageReference('WkzbQMuFYuamGv3YFa~x').owner).toEqual({
			by: 'username',
			username: 'WkzbQMuFYuamGv3YFa',
		});
		expect(parseStorageReference('Wkzb-MuFYuamGv3YF~x').owner).toEqual({
			by: 'username',
			username: 'Wkzb-MuFYuamGv3YF',
		});
	});

	it("`/` is the platform's canonical separator and is accepted too, checked before `~`", () => {
		expect(parseStorageReference('apify/web-scraper-results')).toEqual({
			kind: 'named',
			owner: { by: 'username', username: 'apify' },
			name: 'web-scraper-results',
		});
		expect(parseStorageReference('/my-dataset')).toEqual({
			kind: 'named',
			owner: { by: 'self' },
			name: 'my-dataset',
		});
		// Same as apify-core: `a~b/c` splits on `/`, so the username is `a~b`.
		expect(parseStorageReference('a~b/c')).toEqual({
			kind: 'named',
			owner: { by: 'username', username: 'a~b' },
			name: 'c',
		});
	});

	it('an empty name is the platform\'s "Resource name parameter cannot be empty", not a lookup', () => {
		expect(parseStorageReference('apify~')).toEqual({ kind: 'empty-name' });
		expect(parseStorageReference('~')).toEqual({ kind: 'empty-name' });
		expect(parseStorageReference('/')).toEqual({ kind: 'empty-name' });
		expect(parseStorageReference('WkzbQMuFYuamGv3YF~')).toEqual({ kind: 'empty-name' });
	});

	it('keeps everything after the first separator as the name (documented divergence: apify-core keeps only the second segment)', () => {
		expect(parseStorageReference('~na~me')).toEqual({ kind: 'named', owner: { by: 'self' }, name: 'na~me' });
		expect(parseStorageReference('user~a~b')).toEqual({
			kind: 'named',
			owner: { by: 'username', username: 'user' },
			name: 'a~b',
		});
	});
});
