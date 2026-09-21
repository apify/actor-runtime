import type { Request, Router } from 'express';

import { requireUser } from '../auth.js';

import { getOwnedRun } from '../../services/runs.js';
import { getOwnedStorage } from '../../services/storages.js';
import type { StorageRecord } from '../../storage/entities.js';
import { mountDatasetOperations } from './datasets.js';
import { mountKeyValueStoreOperations } from './key-value-stores.js';
import { mountRequestQueueOperations } from './request-queues.js';
import type { ApiServerDeps } from '../server.js';

async function resolveRunStorage(
	req: Request,
	field: 'defaultDatasetId' | 'defaultKeyValueStoreId' | 'defaultRequestQueueId',
	type: StorageRecord['type'],
): Promise<StorageRecord | null> {
	const run = await getOwnedRun(requireUser(req).id, req.params.runId as string);
	if (!run) return null;
	return getOwnedStorage(requireUser(req).id, run[field], type);
}

/** The `actor-runs/:runId/{dataset,key-value-store,request-queue}/*` default-storage aliases. */
export function mountRunStorageAliases(router: Router, deps: ApiServerDeps): void {
	mountDatasetOperations(
		router,
		'/actor-runs/:runId/dataset',
		(req) => resolveRunStorage(req, 'defaultDatasetId', 'dataset'),
		deps,
	);
	mountKeyValueStoreOperations(router, '/actor-runs/:runId/key-value-store', (req) =>
		resolveRunStorage(req, 'defaultKeyValueStoreId', 'keyValueStore'),
	);
	mountRequestQueueOperations(router, '/actor-runs/:runId/request-queue', (req) =>
		resolveRunStorage(req, 'defaultRequestQueueId', 'requestQueue'),
	);
}
