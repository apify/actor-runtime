/**
 * The standby router (`api.md`'s "Actor Standby"): forwards a request addressed to a standby Actor to
 * one of its standby runs, starting runs as `services/standby.ts` decides. Two addressings, both on the
 * API port: `http://<label>.localhost:3333/<path>` (the Actor's `standbyUrl`, the platform's host-based
 * shape, where the Actor owns `/`) and `/actor-runtime/standby/<label>/<path>` (for Actor containers and
 * clients that do not resolve `*.localhost`). `<label>` is the platform's `<username>--<actor-name>`, or
 * the Actor id.
 *
 * Mounted ahead of the API's body parser, so a request body is streamed through untouched.
 */
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';

import type { Driver } from '../driver/types.js';
import type { ActorRecord, UserRecord } from '../storage/entities.js';
import { getOrCreateUserForToken } from '../services/users.js';
import { listOwnedActors } from '../services/actors.js';
import { STANDBY_PATH_PREFIX, labelFromHost, standbyLabel } from '../services/standby-config.js';
import { StandbyUnavailableError, acquireStandbyRun, type StandbyLease } from '../services/standby.js';

/** Hop-by-hop headers (RFC 9110 7.6.1) never cross a proxy. */
const HOP_BY_HOP_HEADERS = [
	'connection',
	'keep-alive',
	'proxy-connection',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'upgrade',
];

interface StandbyTarget {
	label: string;
	/** Path plus query string, as the Actor's server is to see it. */
	forwardPath: string;
}

/** `undefined` for a request not addressed to a standby Actor at all. */
export function standbyTargetOf(req: IncomingMessage): StandbyTarget | undefined {
	const url = req.url ?? '/';
	const hostLabel = labelFromHost(req.headers.host);
	if (hostLabel) return { label: hostLabel, forwardPath: url.startsWith('/') ? url : `/${url}` };
	if (!url.startsWith(`${STANDBY_PATH_PREFIX}/`)) return undefined;
	const rest = url.slice(STANDBY_PATH_PREFIX.length + 1);
	const end = rest.search(/[/?]/);
	const label = decodeURIComponent(end === -1 ? rest : rest.slice(0, end));
	if (!label) return undefined;
	const remainder = end === -1 ? '' : rest.slice(end);
	return { label: label.toLowerCase(), forwardPath: remainder.startsWith('/') ? remainder : `/${remainder}` };
}

/** Same token sources as the API (`auth.ts`), plus the platform's standby-specific header. Forwarded
 * to the Actor unchanged: an Actor may use its caller's token itself. */
function tokenOf(req: IncomingMessage): string | undefined {
	for (const header of [req.headers.authorization, req.headers['x-apify-authorization']]) {
		const value = Array.isArray(header) ? header[0] : header;
		if (value?.toLowerCase().startsWith('bearer ')) {
			const token = value.slice('bearer '.length).trim();
			if (token) return token;
		}
	}
	const token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
	return token || undefined;
}

async function resolveStandbyActor(user: UserRecord, label: string): Promise<ActorRecord | undefined> {
	const owned = await listOwnedActors(user.id);
	return owned.find((actor) => actor.id.toLowerCase() === label || standbyLabel(actor, user.username) === label);
}

type Resolution =
	{ kind: 'ok'; lease: StandbyLease } | { kind: 'error'; status: number; type: string; message: string };

async function resolveLease(driver: Driver, req: IncomingMessage, target: StandbyTarget): Promise<Resolution> {
	const token = tokenOf(req);
	if (!token) {
		return {
			kind: 'error',
			status: 401,
			type: 'user-not-authenticated',
			message: 'Authentication token is not provided',
		};
	}
	try {
		const user = await getOrCreateUserForToken(token);
		const actor = await resolveStandbyActor(user, target.label);
		if (!actor) {
			return {
				kind: 'error',
				status: 404,
				type: 'record-not-found',
				message: `No Actor of yours is served at standby address "${target.label}"`,
			};
		}
		return { kind: 'ok', lease: await acquireStandbyRun(driver, actor, user) };
	} catch (error) {
		if (error instanceof StandbyUnavailableError) {
			return { kind: 'error', status: error.status, type: error.type, message: error.message };
		}
		console.error('standby router: unexpected error', error);
		return {
			kind: 'error',
			status: 500,
			type: 'internal-error',
			message: error instanceof Error ? error.message : 'Internal error',
		};
	}
}

function forwardedHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
	const forwarded: IncomingHttpHeaders = { ...headers };
	for (const name of HOP_BY_HOP_HEADERS) delete forwarded[name];
	return forwarded;
}

function sendJsonError(res: ServerResponse, status: number, type: string, message: string): void {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify({ error: { type, message } }));
}

/** Express-compatible middleware; passes everything not addressed to a standby Actor on to `next`. */
export function standbyProxy(driver: Driver) {
	return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
		const target = standbyTargetOf(req);
		if (!target) {
			next();
			return;
		}
		// Held until a run is ready; nothing is read from the body before then.
		req.pause();
		void resolveLease(driver, req, target).then((resolution) => {
			if (resolution.kind === 'error') {
				req.resume();
				sendJsonError(res, resolution.status, resolution.type, resolution.message);
				return;
			}
			forwardRequest(req, res, target, resolution.lease);
		});
	};
}

function forwardRequest(req: IncomingMessage, res: ServerResponse, target: StandbyTarget, lease: StandbyLease): void {
	res.once('close', () => lease.release());
	const upstream = http.request(
		{
			host: lease.address.host,
			port: lease.address.port,
			method: req.method,
			path: target.forwardPath,
			headers: forwardedHeaders(req.headers),
		},
		(upstreamRes) => {
			const headers = { ...upstreamRes.headers };
			for (const name of HOP_BY_HOP_HEADERS) delete headers[name];
			res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, headers);
			upstreamRes.pipe(res);
		},
	);
	upstream.on('error', (error: NodeJS.ErrnoException) => {
		if (error.code === 'ECONNREFUSED') lease.markUnreachable();
		sendJsonError(
			res,
			502,
			'standby-bad-gateway',
			`The Actor's standby run ${lease.runId} did not answer: ${error.message}`,
		);
	});
	// A client that goes away takes its upstream request with it (and so frees the run's slot).
	res.once('close', () => {
		if (!res.writableFinished) upstream.destroy();
	});
	req.pipe(upstream);
	req.resume();
}

/** Upgraded sockets are not HTTP connections any more, so `closeAllConnections()` cannot end them. */
const upgradedSockets = new Set<Duplex>();

/** Ends every proxied websocket; a graceful shutdown would otherwise wait on them indefinitely. */
export function closeStandbyUpgrades(): void {
	for (const socket of upgradedSockets) socket.destroy();
	upgradedSockets.clear();
}

/** The websocket counterpart of `standbyProxy`, for the API server's `upgrade` event. Returns `false`
 * for an upgrade not addressed to a standby Actor, leaving it to the next handler. */
export function handleStandbyUpgrade(driver: Driver, req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
	const target = standbyTargetOf(req);
	if (!target) return false;
	socket.on('error', () => socket.destroy());
	upgradedSockets.add(socket);
	socket.once('close', () => upgradedSockets.delete(socket));
	void resolveLease(driver, req, target).then((resolution) => {
		if (resolution.kind === 'error') {
			const body = JSON.stringify({ error: { type: resolution.type, message: resolution.message } });
			socket.end(
				`HTTP/1.1 ${resolution.status} ${http.STATUS_CODES[resolution.status] ?? 'Error'}\r\n` +
					`content-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\n` +
					`connection: close\r\n\r\n${body}`,
			);
			return;
		}
		const { lease } = resolution;
		const upstream = net.connect(lease.address.port, lease.address.host, () => {
			const lines = [`${req.method ?? 'GET'} ${target.forwardPath} HTTP/1.1`];
			for (let i = 0; i < req.rawHeaders.length; i += 2)
				lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
			upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
			if (head.length > 0) upstream.write(head);
			upstream.pipe(socket);
			socket.pipe(upstream);
		});
		let released = false;
		const close = () => {
			if (!released) {
				released = true;
				lease.release();
			}
			upstream.destroy();
			socket.destroy();
		};
		upstream.on('error', (error: NodeJS.ErrnoException) => {
			if (error.code === 'ECONNREFUSED') lease.markUnreachable();
			close();
		});
		upstream.on('close', close);
		socket.on('close', close);
	});
	return true;
}
