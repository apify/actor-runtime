/**
 * Hosted mode's single listener: the platform delivers every request to one port, so the API and the
 * console are told apart by path. `/v2`, `/actor-runtime` and the run web-server and standby proxies
 * live under the API's prefixes; every other path is the console.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Express } from 'express';

import { hostedAuthMiddleware, type HostedAuth } from './auth.js';

const API_PREFIXES = ['/v2', '/actor-runtime'];

export function isApiPath(path: string): boolean {
	return API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export interface HostedServerDeps {
	apiApp: Express;
	consoleApp: Express;
	auth: HostedAuth;
}

export function createHostedServer({ apiApp, consoleApp, auth }: HostedServerDeps): Server {
	const guard = hostedAuthMiddleware(auth, isApiPath, ['/actor-runtime/skill']);
	return createServer((req: IncomingMessage, res: ServerResponse) => {
		guard(req, res, () => {
			const path = new URL(req.url ?? '/', 'http://localhost').pathname;
			(isApiPath(path) ? apiApp : consoleApp)(req, res);
		});
	});
}
