/** Every form a resource segment can take, and which owner counts as the caller (`api.md`'s
 * "Resource id encoding"). */
import { describe, expect, it } from 'vitest';

import { isCallerOwner, parseResourceReference } from '../../src/services/resource-reference.js';
import type { UserRecord } from '../../src/storage/entities.js';

describe('parseResourceReference', () => {
	it('a segment without a separator is an id - never a bare name, unlike :actorId', () => {
		expect(parseResourceReference('WkzbQMuFYuamGv3YF')).toEqual({ kind: 'id', id: 'WkzbQMuFYuamGv3YF' });
		expect(parseResourceReference('my-dataset')).toEqual({ kind: 'id', id: 'my-dataset' });
		expect(parseResourceReference('')).toEqual({ kind: 'id', id: '' });
	});

	it("`~name` (empty prefix) is the caller's own named storage", () => {
		expect(parseResourceReference('~my-dataset')).toEqual({
			kind: 'named',
			owner: { by: 'self' },
			name: 'my-dataset',
		});
	});

	it('`username~name` names another user by username', () => {
		expect(parseResourceReference('apify~web-scraper-results')).toEqual({
			kind: 'named',
			owner: { by: 'username', username: 'apify' },
			name: 'web-scraper-results',
		});
		// Casing is preserved here - `resolveOwnedStorage` is what compares case-insensitively.
		expect(parseResourceReference('Local-User-1~My-Store')).toEqual({
			kind: 'named',
			owner: { by: 'username', username: 'Local-User-1' },
			name: 'My-Store',
		});
	});

	it('a 17-character alphanumeric prefix is a user id, not a username - the platform forbids usernames of that shape', () => {
		expect(parseResourceReference('WkzbQMuFYuamGv3YF~my-dataset')).toEqual({
			kind: 'named',
			owner: { by: 'userId', userId: 'WkzbQMuFYuamGv3YF' },
			name: 'my-dataset',
		});
		// This runtime's own fabricated user ids (`0000000000000000{n}`) are 17 alphanumerics too.
		expect(parseResourceReference('00000000000000001~my-dataset')).toEqual({
			kind: 'named',
			owner: { by: 'userId', userId: '00000000000000001' },
			name: 'my-dataset',
		});
		// 16 or 18 characters, or a non-alphanumeric character, is a username.
		expect(parseResourceReference('WkzbQMuFYuamGv3Y~x').owner).toEqual({
			by: 'username',
			username: 'WkzbQMuFYuamGv3Y',
		});
		expect(parseResourceReference('WkzbQMuFYuamGv3YFa~x').owner).toEqual({
			by: 'username',
			username: 'WkzbQMuFYuamGv3YFa',
		});
		expect(parseResourceReference('Wkzb-MuFYuamGv3YF~x').owner).toEqual({
			by: 'username',
			username: 'Wkzb-MuFYuamGv3YF',
		});
	});

	it("`/` is the platform's canonical separator and is accepted too, checked before `~`", () => {
		expect(parseResourceReference('apify/web-scraper-results')).toEqual({
			kind: 'named',
			owner: { by: 'username', username: 'apify' },
			name: 'web-scraper-results',
		});
		expect(parseResourceReference('/my-dataset')).toEqual({
			kind: 'named',
			owner: { by: 'self' },
			name: 'my-dataset',
		});
		// Same as apify-core: `a~b/c` splits on `/`, so the username is `a~b`.
		expect(parseResourceReference('a~b/c')).toEqual({
			kind: 'named',
			owner: { by: 'username', username: 'a~b' },
			name: 'c',
		});
	});

	it('an empty name is the platform\'s "Resource name parameter cannot be empty", not a lookup', () => {
		expect(parseResourceReference('apify~')).toEqual({ kind: 'empty-name' });
		expect(parseResourceReference('~')).toEqual({ kind: 'empty-name' });
		expect(parseResourceReference('/')).toEqual({ kind: 'empty-name' });
		expect(parseResourceReference('WkzbQMuFYuamGv3YF~')).toEqual({ kind: 'empty-name' });
	});

	it('keeps everything after the first separator as the name (documented divergence: apify-core keeps only the second segment)', () => {
		expect(parseResourceReference('~na~me')).toEqual({ kind: 'named', owner: { by: 'self' }, name: 'na~me' });
		expect(parseResourceReference('user~a~b')).toEqual({
			kind: 'named',
			owner: { by: 'username', username: 'user' },
			name: 'a~b',
		});
	});
});

describe('isCallerOwner', () => {
	const user: UserRecord = {
		id: 'WkzbQMuFYuamGv3YF',
		username: 'Local-User-1',
		token: 't',
		createdAt: new Date().toISOString(),
	};

	it('an empty prefix (`~name`) is always the caller', () => {
		expect(isCallerOwner(user, { by: 'self' })).toBe(true);
	});

	it('a username matches case-insensitively, a different one never matches', () => {
		expect(isCallerOwner(user, { by: 'username', username: 'local-user-1' })).toBe(true);
		expect(isCallerOwner(user, { by: 'username', username: 'LOCAL-USER-1' })).toBe(true);
		expect(isCallerOwner(user, { by: 'username', username: 'apify' })).toBe(false);
	});

	it("a user id matches exactly, and never another user's", () => {
		expect(isCallerOwner(user, { by: 'userId', userId: 'WkzbQMuFYuamGv3YF' })).toBe(true);
		expect(isCallerOwner(user, { by: 'userId', userId: '00000000000000009' })).toBe(false);
		// Ids are not names: casing is part of the id, so a case-varied id is a different user.
		expect(isCallerOwner(user, { by: 'userId', userId: 'wkzbqmufyuamgv3yf' })).toBe(false);
	});
});
