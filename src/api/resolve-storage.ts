import type { Request } from 'express';

import type { StorageRecord, StorageType } from '../storage/entities.js';
import { parseStorageReference } from '../services/storage-reference.js';
import { resolveOwnedStorage } from '../services/storages.js';
import { requireUser } from './auth.js';
import { invalidRequest } from './errors.js';

/**
 * The one way a `/v2/datasets/:datasetId`, `/v2/key-value-stores/:storeId` or
 * `/v2/request-queues/:queueId` route turns its path parameter into the caller's storage record - by
 * id, or by any of the named forms `api.md`'s "Storage id encoding" lists (`~name`, `username~name`,
 * `userId~name`). `null` means "no such storage of the caller's", and every caller turns that into
 * `record-not-found` - the outcome that keeps a named reference the runtime cannot satisfy eligible for
 * the `fallbackNotFoundEnabled` upstream relay (`services/api-fallback.ts`), where the platform's own
 * storage and access rules then decide for the byte-identical URL.
 *
 * The one non-`null`, non-record outcome is the platform's own `400 invalid-request` for an empty name
 * (`username~`, `~`) - thrown here, as an `ApiError`, so it surfaces through `handler.ts: h()` exactly like
 * every other request-shape error, and is never relayed (`invalid-request` is not a fallback trigger).
 */
export async function resolveStorageParam(
	req: Request,
	param: 'datasetId' | 'storeId' | 'queueId',
	type: StorageType,
): Promise<StorageRecord | null> {
	const reference = parseStorageReference(req.params[param] as string);
	if (reference.kind === 'empty-name') throw invalidRequest('Resource name parameter cannot be empty');
	return resolveOwnedStorage(requireUser(req), reference, type);
}
