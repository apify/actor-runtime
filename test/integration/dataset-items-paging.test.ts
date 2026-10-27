/**
 * Paging of `GET /v2/datasets/:datasetId/items`: a request without `limit` gets the default page,
 * `offset`/`limit` reach the rest, and the `x-apify-pagination-*` headers describe the page.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';

import { DEFAULT_ITEMS_PAGE_LIMIT } from '../../src/api/routes/datasets.js';
import { startTestServer, type TestServerHandle } from './helpers/test-server.js';

describe('dataset items paging', () => {
	let server: TestServerHandle;

	beforeEach(async () => {
		server = await startTestServer();
	});

	afterEach(async () => {
		await server.close();
	});

	async function items(datasetId: string, query = '') {
		return axios.get(`${server.baseUrl}/v2/datasets/${datasetId}/items${query}`, {
			headers: { Authorization: `Bearer ${server.token}` },
			validateStatus: () => true,
		});
	}

	it('serves the default page when no limit is given, and the rest by offset', async () => {
		const total = DEFAULT_ITEMS_PAGE_LIMIT + 50;
		const dataset = await server.client.datasets().getOrCreate('paged');
		await server.client.dataset(dataset.id).pushItems(Array.from({ length: total }, (_, n) => ({ n })));

		const first = await items(dataset.id);
		expect(first.status).toBe(200);
		expect(first.data).toHaveLength(DEFAULT_ITEMS_PAGE_LIMIT);
		expect(first.data[0]).toEqual({ n: 0 });
		expect(first.headers['x-apify-pagination-total']).toBe(String(total));
		expect(first.headers['x-apify-pagination-count']).toBe(String(DEFAULT_ITEMS_PAGE_LIMIT));
		expect(first.headers['x-apify-pagination-limit']).toBe(String(DEFAULT_ITEMS_PAGE_LIMIT));

		const rest = await items(dataset.id, `?offset=${DEFAULT_ITEMS_PAGE_LIMIT}`);
		expect(rest.data).toHaveLength(50);
		expect(rest.data[0]).toEqual({ n: DEFAULT_ITEMS_PAGE_LIMIT });

		const explicit = await items(dataset.id, '?limit=5&offset=10');
		expect(explicit.data.map((item: { n: number }) => item.n)).toEqual([10, 11, 12, 13, 14]);
	});
});
