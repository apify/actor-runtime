/**
 * Hosted-mode authentication (`requirements/hosted.md`). The runtime is reachable from the internet
 * through the standby URL, so the local "any non-empty token" rule does not apply: a caller must hold a
 * real Apify token of the account that owns this run. Tokens are checked against the real platform and
 * the verdict is cached briefly.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export const READINESS_PROBE_HEADER = 'x-apify-container-server-readiness-probe';
export const TOKEN_COOKIE = 'apify_runtime_token';
const CACHE_TTL_MS = 5 * 60_000;

export interface HostedAuthOptions {
	/** Account id allowed in (`APIFY_USER_ID` of this run). */
	ownerId: string;
	apiBaseUrl: string;
	fetchFn?: typeof fetch;
	now?: () => number;
}

export type TokenSource = 'header' | 'query' | 'cookie';

export function tokenFromRequest(req: IncomingMessage): { token: string; source: TokenSource } | undefined {
	for (const header of [req.headers.authorization, req.headers['x-apify-authorization']]) {
		const value = Array.isArray(header) ? header[0] : header;
		if (value?.toLowerCase().startsWith('bearer ')) {
			const token = value.slice('bearer '.length).trim();
			if (token) return { token, source: 'header' };
		}
	}
	const query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
	if (query) return { token: query, source: 'query' };
	const cookie = (req.headers.cookie ?? '')
		.split(';')
		.map((part) => part.trim().split('='))
		.find(([name]) => name === TOKEN_COOKIE);
	const cookieToken = cookie?.slice(1).join('=');
	return cookieToken ? { token: decodeURIComponent(cookieToken), source: 'cookie' } : undefined;
}

export class HostedAuth {
	private readonly verdicts = new Map<string, { ok: boolean; until: number }>();
	private readonly fetchFn: typeof fetch;
	private readonly now: () => number;

	constructor(private readonly options: HostedAuthOptions) {
		this.fetchFn = options.fetchFn ?? fetch;
		this.now = options.now ?? Date.now;
	}

	/** Whether `token` belongs to the owning account. Network failures deny, and are not cached. */
	async isOwner(token: string): Promise<boolean> {
		const cached = this.verdicts.get(token);
		if (cached && cached.until > this.now()) return cached.ok;
		try {
			const response = await this.fetchFn(`${this.options.apiBaseUrl}/v2/users/me`, {
				headers: { authorization: `Bearer ${token}` },
			});
			const body = response.ok ? ((await response.json()) as { data?: { id?: string } }) : undefined;
			const ok = body?.data?.id === this.options.ownerId;
			this.verdicts.set(token, { ok, until: this.now() + CACHE_TTL_MS });
			return ok;
		} catch {
			return false;
		}
	}
}

function deny(res: ServerResponse, status: number, type: string, message: string): void {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify({ error: { type, message } }));
}

/** `isApiPath` decides where a cookie is honoured: never on the API, so a browser session cannot be
 * driven cross-site into API writes. */
export function hostedAuthMiddleware(auth: HostedAuth, isApiPath: (path: string) => boolean, publicPaths: string[]) {
	return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
		if (req.headers[READINESS_PROBE_HEADER] !== undefined) {
			res.writeHead(200, { 'content-type': 'text/plain' });
			res.end('ok');
			return;
		}
		const url = new URL(req.url ?? '/', 'http://localhost');
		if (publicPaths.includes(url.pathname)) {
			next();
			return;
		}
		const found = tokenFromRequest(req);
		const api = isApiPath(url.pathname);
		if (!found || (api && found.source === 'cookie')) {
			deny(res, 401, 'user-not-authenticated', 'Authentication token is not provided');
			return;
		}
		void auth.isOwner(found.token).then((ok) => {
			if (!ok) {
				deny(res, 403, 'forbidden', 'This runtime accepts only tokens of the account that started it');
				return;
			}
			if (!api && found.source === 'query' && req.method === 'GET') {
				// Console navigation: swap the query token for a cookie so links and forms need no token.
				url.searchParams.delete('token');
				res.writeHead(302, {
					location: `${url.pathname}${url.search}`,
					'set-cookie': `${TOKEN_COOKIE}=${encodeURIComponent(found.token)}; HttpOnly; Secure; SameSite=Strict; Path=/`,
				});
				res.end();
				return;
			}
			next();
		});
	};
}
