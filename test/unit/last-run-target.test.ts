/** `lastRunTargetUrl` (`api/routes/last-run.ts`) alone; the re-dispatch it feeds is covered by
 * `test/integration/last-run.test.ts`. */
import { describe, expect, it } from 'vitest';

import { lastRunTargetUrl } from '../../src/api/routes/last-run.js';
import { ApiError } from '../../src/api/errors.js';
import type { RunRecord } from '../../src/storage/entities.js';

const run = {
	id: 'RUN1',
	defaultDatasetId: 'DS1',
	defaultKeyValueStoreId: 'KV1',
	defaultRequestQueueId: 'RQ1',
} as RunRecord;

function expectNotFound(fn: () => unknown): void {
	let thrown: unknown;
	try {
		fn();
	} catch (err) {
		thrown = err;
	}
	expect(thrown).toBeInstanceOf(ApiError);
	expect((thrown as ApiError).status).toBe(404);
	expect((thrown as ApiError).type).toBe('not-found');
}

describe('lastRunTargetUrl', () => {
	it('maps the bare form to the run object, GET/HEAD only', () => {
		expect(lastRunTargetUrl('GET', '/actors/A/runs/last', run)).toBe('/v2/actor-runs/RUN1');
		expect(lastRunTargetUrl('GET', '/actors/A/runs/last/', run)).toBe('/v2/actor-runs/RUN1');
		expect(lastRunTargetUrl('HEAD', '/actors/A/runs/last', run)).toBe('/v2/actor-runs/RUN1');
		expect(lastRunTargetUrl('GET', '/actors/A/runs/last?status=SUCCEEDED', run)).toBe(
			'/v2/actor-runs/RUN1?status=SUCCEEDED',
		);
		// Never a shortcut to `DELETE actor-runs/:runId`.
		expectNotFound(() => lastRunTargetUrl('DELETE', '/actors/A/runs/last', run));
		expectNotFound(() => lastRunTargetUrl('POST', '/actors/A/runs/last', run));
		expectNotFound(() => lastRunTargetUrl('PUT', '/actors/A/runs/last?status=SUCCEEDED', run));
	});

	it('maps log to logs/:runId, dropping anything after log but keeping the query string', () => {
		expect(lastRunTargetUrl('GET', '/actors/A/runs/last/log', run)).toBe('/v2/logs/RUN1');
		expect(lastRunTargetUrl('GET', '/actors/A/runs/last/log?stream=true&status=RUNNING', run)).toBe(
			'/v2/logs/RUN1?stream=true&status=RUNNING',
		);
		expect(lastRunTargetUrl('GET', '/actors/A/runs/last/log/extra/bits', run)).toBe('/v2/logs/RUN1');
	});

	it('maps the three default storages onto their own resource paths, sub-path and query intact', () => {
		expect(lastRunTargetUrl('GET', '/actors/A/runs/last/dataset', run)).toBe('/v2/datasets/DS1');
		expect(lastRunTargetUrl('GET', '/actors/A/runs/last/dataset/items?clean=true&limit=5', run)).toBe(
			'/v2/datasets/DS1/items?clean=true&limit=5',
		);
		expect(lastRunTargetUrl('POST', '/actors/A/runs/last/dataset/items', run)).toBe('/v2/datasets/DS1/items');
		expect(lastRunTargetUrl('GET', '/actors/A/runs/last/key-value-store/keys', run)).toBe(
			'/v2/key-value-stores/KV1/keys',
		);
		expect(lastRunTargetUrl('PUT', '/actors/A/runs/last/key-value-store/records/OUTPUT', run)).toBe(
			'/v2/key-value-stores/KV1/records/OUTPUT',
		);
		expect(lastRunTargetUrl('GET', '/actors/A/runs/last/request-queue/head?limit=3', run)).toBe(
			'/v2/request-queues/RQ1/head?limit=3',
		);
		expect(lastRunTargetUrl('POST', '/actors/A/runs/last/request-queue/requests/batch', run)).toBe(
			'/v2/request-queues/RQ1/requests/batch',
		);
	});

	it('forwards the sub-path byte for byte - percent-encoding is neither decoded nor re-encoded', () => {
		expect(lastRunTargetUrl('GET', '/actors/A/runs/last/key-value-store/records/my%20key%2Fslash', run)).toBe(
			'/v2/key-value-stores/KV1/records/my%20key%2Fslash',
		);
	});

	it('maps abort, reboot and metamorph onto the run, method left to the target', () => {
		expect(lastRunTargetUrl('POST', '/actors/A/runs/last/abort?gracefully=true', run)).toBe(
			'/v2/actor-runs/RUN1/abort?gracefully=true',
		);
		expect(lastRunTargetUrl('POST', '/actors/A/runs/last/reboot', run)).toBe('/v2/actor-runs/RUN1/reboot');
		expect(lastRunTargetUrl('POST', '/actors/A/runs/last/metamorph', run)).toBe('/v2/actor-runs/RUN1/metamorph');
		// Forwarded, and left to the target to reject.
		expect(lastRunTargetUrl('POST', '/actors/A/runs/last/abort/extra', run)).toBe(
			'/v2/actor-runs/RUN1/abort/extra',
		);
	});

	it('is positional, so the case-insensitive route match cannot confuse it', () => {
		expect(lastRunTargetUrl('GET', '/ACTORS/A/RUNS/LAST/dataset/items', run)).toBe('/v2/datasets/DS1/items');
	});

	it('rejects any other first segment as not-found, real run endpoints without a last-run form included', () => {
		expectNotFound(() => lastRunTargetUrl('GET', '/actors/A/runs/last/foo', run));
		expectNotFound(() => lastRunTargetUrl('POST', '/actors/A/runs/last/resurrect', run));
		expectNotFound(() => lastRunTargetUrl('GET', '/actors/A/runs/last/datasets/items', run));
	});
});
