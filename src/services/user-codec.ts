import type { RecordCodec } from '../storage/registry.js';
import type { UserRecord } from '../storage/entities.js';
import { hashToken, seal, unseal } from './token-vault.js';

/** A `__USERS__` record as written to disk: the user's credentials only ever sealed (`token-vault.ts`). */
interface StoredUser {
	id: string;
	username: string;
	createdAt: string;
	tokenHashes: string[];
	sealed: string;
}

interface SealedCredentials {
	token?: string;
	proxyPassword?: string;
}

/** A record written before tokens were sealed, rewritten sealed on start (`Registry.rewriteOutdated`). */
interface LegacyUser {
	id: string;
	username: string;
	createdAt: string;
	token: string;
	tokens?: string[];
	proxyPassword?: string;
}

function isLegacyUser(stored: unknown): stored is LegacyUser {
	return typeof (stored as LegacyUser).token === 'string';
}

export const userCodec: RecordCodec<UserRecord> = {
	isOutdated: isLegacyUser,
	encode({ id, username, createdAt, tokenHashes, token, proxyPassword }): StoredUser {
		const credentials: SealedCredentials = { token, proxyPassword };
		return { id, username, createdAt, tokenHashes, sealed: seal(credentials, id) };
	},
	decode(stored): UserRecord {
		if (isLegacyUser(stored)) {
			const { id, username, createdAt, token, tokens, proxyPassword } = stored;
			return { id, username, createdAt, token, tokenHashes: (tokens ?? [token]).map(hashToken), proxyPassword };
		}
		const { id, username, createdAt, tokenHashes, sealed } = stored as StoredUser;
		const credentials = unseal<SealedCredentials>(sealed, id) ?? {};
		return {
			id,
			username,
			createdAt,
			tokenHashes,
			...(credentials.token !== undefined ? { token: credentials.token } : {}),
			...(credentials.proxyPassword !== undefined ? { proxyPassword: credentials.proxyPassword } : {}),
		};
	},
};
