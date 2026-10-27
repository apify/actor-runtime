/**
 * Paging of `GET /v2/datasets/:datasetId/items`: a request without `limit` gets every item from
 * `offset` on, as on the platform, and the `x-apify-pagination-*` headers describe the page.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';

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

	it('serves every item when no limit is given, and a page by offset and limit', async () => {
		const total = 300;
		const dataset = await server.client.datasets().getOrCreate('paged');
		await server.client.dataset(dataset.id).pushItems(Array.from({ length: total }, (_, n) => ({ n })));

		const all = await items(dataset.id);
		expect(all.status).toBe(200);
		expect(all.data).toHaveLength(total);
		expect(all.headers['x-apify-pagination-total']).toBe(String(total));
		expect(all.headers['x-apify-pagination-count']).toBe(String(total));
		expect(all.headers['x-apify-pagination-limit']).toBe('999999999999');

		const fromOffset = await items(dataset.id, '?offset=250');
		expect(fromOffset.data).toHaveLength(50);
		expect(fromOffset.data[0]).toEqual({ n: 250 });

		const page = await items(dataset.id, '?limit=5&offset=10');
		expect(page.data.map((item: { n: number }) => item.n)).toEqual([10, 11, 12, 13, 14]);
		expect(page.headers['x-apify-pagination-limit']).toBe('5');
	});
});
