import type { Request } from 'express';

import type { ActorRecord, StorageRecord, StorageType } from '../storage/entities.js';
import { parseResourceReference, type ResolvableReference } from '../services/resource-reference.js';
import { resolveOwnedActor } from '../services/actors.js';
import { resolveOwnedStorage } from '../services/storages.js';
import { requireUser } from './auth.js';
import { invalidRequest } from './errors.js';

/**
 * The one way a route turns its `:actorId` / `:datasetId` / `:storeId` / `:queueId` path parameter into
 * the caller's record - by id, or by any of the named forms `api.md`'s "Resource id encoding" lists
 * (`~name`, `username~name`, `userId~name`). `null` means "no such resource of the caller's", and every
 * caller turns that into `record-not-found` - the outcome that keeps a reference the runtime cannot
 * satisfy eligible for the `fallbackNotFoundEnabled` upstream relay (`services/api-fallback.ts`), where
 * the platform's own rules then decide for the byte-identical URL.
 *
 * The one non-`null`, non-record outcome is the platform's own `400 invalid-request` for an empty name
 * (`username~`, `~`) - thrown here, as an `ApiError`, so it surfaces through `handler.ts: h()` exactly
 * like every other request-shape error, and is never relayed (`invalid-request` is not a fallback
 * trigger).
 */
function referenceFrom(req: Request, param: string): ResolvableReference {
	const reference = parseResourceReference(req.params[param] as string);
	if (reference.kind === 'empty-name') throw invalidRequest('Resource name parameter cannot be empty');
	return reference;
}

export async function resolveActorParam(req: Request): Promise<ActorRecord | null> {
	return resolveOwnedActor(requireUser(req), referenceFrom(req, 'actorId'));
}

export async function resolveStorageParam(
	req: Request,
	param: 'datasetId' | 'storeId' | 'queueId',
	type: StorageType,
): Promise<StorageRecord | null> {
	return resolveOwnedStorage(requireUser(req), referenceFrom(req, param), type);
}
