/**
 * A stand-in for `https://api.apify.com`, for every integration test that has to prove what the runtime
 * did or did not send upstream (`test/integration/api-fallback.test.ts`, `last-run.test.ts`). Point
 * `APIFY_UPSTREAM_API_BASE_URL` at `baseUrl` and every relayed request lands here instead - never real
 * egress. Same pattern `identity-resolution.test.ts` established for the identity probe.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import axios from 'axios';

export interface CapturedRequest {
	method: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	body: Buffer;
}

export interface StubUpstream {
	baseUrl: string;
	hitCount: () => number;
	requests: () => CapturedRequest[];
	close: () => Promise<void>;
}

/** Stands in for `https://api.apify.com`, generically: `respond` decides the status/body/headers for
 * every request; passing `'hang'` never calls back at all (simulating a stalled upstream past any
 * timeout). Every hit is recorded (method/url/headers/body), so a test can assert what the runtime
 * actually sent upstream, not just what it got back. A header value may be a `string[]` (not just a
 * `string`) so a test can make the stub send the same header name as two separate raw wire lines - e.g.
 * two `Set-Cookie` lines - rather than one value; `http.ServerResponse.writeHead` sends an array value as
 * repeated lines for any header name, not only `set-cookie`. */
export function startStubUpstream(
	respond: (
		req: CapturedRequest,
	) => { status: number; body?: unknown; headers?: Record<string, string | string[]> } | 'hang',
): Promise<StubUpstream> {
	const requests: CapturedRequest[] = [];
	return new Promise((resolveServer) => {
		const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
			const chunks: Buffer[] = [];
			req.on('data', (chunk: Buffer) => chunks.push(chunk));
			req.on('end', () => {
				const captured: CapturedRequest = {
					method: req.method ?? '',
					url: req.url ?? '',
					headers: req.headers,
					body: Buffer.concat(chunks),
				};
				requests.push(captured);
				const outcome = respond(captured);
				if (outcome === 'hang') return; // never respond - the client's own timeout must fire
				res.writeHead(outcome.status, { 'content-type': 'application/json', ...outcome.headers });
				res.end(outcome.body === undefined ? '' : JSON.stringify(outcome.body));
			});
		});
		server.listen(0, () => {
			const { port } = server.address() as AddressInfo;
			resolveServer({
				baseUrl: `http://127.0.0.1:${port}`,
				hitCount: () => requests.length,
				requests: () => requests,
				close: () => new Promise<void>((resolve) => server.close(() => resolve())),
			});
		});
	});
}

/** Makes one authenticated request so `services/users.ts: getOrCreateUserForToken()`'s one-time
 * identity probe for `token` runs and gets cached *now*, against whatever upstream is currently
 * configured - before a test points `APIFY_UPSTREAM_API_BASE_URL` at its own fallback stub. Without
 * this, the identity probe for a never-before-seen token would itself be the first request to reach
 * that stub. */
export async function warmUpIdentity(baseUrl: string, token: string): Promise<void> {
	await axios.get(`${baseUrl}/v2/users/me`, {
		headers: { Authorization: `Bearer ${token}` },
		validateStatus: () => true,
	});
}
