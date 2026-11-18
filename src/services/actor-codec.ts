import type { RecordCodec } from '../storage/registry.js';
import type { ActorRecord, ActorSecretKeys } from '../storage/entities.js';
import { seal, unseal } from './token-vault.js';

/** `secretKeys` as written to disk: the private key is already protected by the passphrase, so sealing the
 * passphrase alone keeps the Actor's secrets unreadable to anyone without the runtime's key file. */
interface StoredSecretKeys {
	publicKey: string;
	privateKey: string;
	sealedPassphrase: string;
}

type StoredActor = Omit<ActorRecord, 'secretKeys'> & { secretKeys?: StoredSecretKeys | ActorSecretKeys };

export const actorCodec: RecordCodec<ActorRecord> = {
	isOutdated: (stored) => {
		const { secretKeys } = stored as StoredActor;
		return secretKeys !== undefined && 'passphrase' in secretKeys;
	},
	encode(actor): StoredActor {
		if (!actor.secretKeys) return actor;
		const { publicKey, privateKey, passphrase } = actor.secretKeys;
		return { ...actor, secretKeys: { publicKey, privateKey, sealedPassphrase: seal(passphrase, actor.id) } };
	},
	decode(stored): ActorRecord {
		const { secretKeys, ...actor } = stored as StoredActor;
		// Written before passphrases were sealed: read as is, rewritten sealed on start (`Registry.rewriteOutdated`).
		if (!secretKeys || 'passphrase' in secretKeys) return stored as ActorRecord;
		const passphrase = unseal<string>(secretKeys.sealedPassphrase, actor.id);
		// Unreadable once the key file is deleted: a key pair that cannot open is no key pair, so a new one
		// is made on the next write or run (`secrets.ts: ensureSecretKeys`).
		if (typeof passphrase !== 'string') return actor;
		return {
			...actor,
			secretKeys: { publicKey: secretKeys.publicKey, privateKey: secretKeys.privateKey, passphrase },
		};
	},
};
