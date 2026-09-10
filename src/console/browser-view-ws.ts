/**
 * `GET /runs/:runId/browser/ws`: bridges the viewer page's noVNC client to the run's sidecar VNC server over
 * `apify-local` (the runtime plays websockify). Upgraded on the console server directly, like
 * `api/events-ws.ts` on the API server. Unauthenticated like the rest of the console.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { connect, type Socket } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import { getRunById } from '../services/runs.js';
import { getActorById } from '../services/actors.js';
import { isTerminalJobStatus } from '../services/job-status.js';
import type { RunRecord } from '../storage/entities.js';

const BROWSER_VIEW_WS_PATH_PATTERN = /^\/runs\/([^/]+)\/browser\/ws$/;

/** The sidecar's VNC server only listens once the Actor's X display exists; dial retries cover the gap. */
const VNC_CONNECT_TIMEOUT_MS = 120_000;
const VNC_CONNECT_RETRY_MS = 500;

export interface BrowserViewWebSocketServer {
	/** Same contract as `EventsWebSocketServer.close()`. */
	close(): void;
}

export function extractBrowserViewRunId(pathname: string): string | undefined {
	return BROWSER_VIEW_WS_PATH_PATTERN.exec(pathname)?.[1];
}

function dialOnce(host: string, port: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host, port });
		socket.once('connect', () => {
			socket.removeListener('error', reject);
			resolve(socket);
		});
		socket.once('error', reject);
	});
}

/** Resolves `undefined` when cancelled or out of budget; never rejects. */
async function dialWithRetry(host: string, port: number, isCancelled: () => boolean): Promise<Socket | undefined> {
	const deadline = Date.now() + VNC_CONNECT_TIMEOUT_MS;
	for (;;) {
		if (isCancelled()) return undefined;
		try {
			return await dialOnce(host, port);
		} catch {
			if (Date.now() >= deadline) return undefined;
			await new Promise((resolve) => setTimeout(resolve, VNC_CONNECT_RETRY_MS));
		}
	}
}

function toBuffer(data: RawData): Buffer {
	if (Buffer.isBuffer(data)) return data;
	if (Array.isArray(data)) return Buffer.concat(data);
	return Buffer.from(data);
}

type MirroredRun = RunRecord & { localBrowserView: NonNullable<RunRecord['localBrowserView']> };

/** The run's mirror address, or a `1008` reason. Waits while the mirror is still starting (see
 * `isBrowserViewPending`). */
async function awaitMirroredRun(runId: string, isCancelled: () => boolean): Promise<MirroredRun | string> {
	const deadline = Date.now() + VNC_CONNECT_TIMEOUT_MS;
	for (;;) {
		const run = await getRunById(runId);
		if (!run) return `Unknown run id: ${runId}`;
		if (run.localBrowserView) {
			if (isTerminalJobStatus(run.status)) return `Run ${runId} has already ended`;
			return run as MirroredRun;
		}
		if (isTerminalJobStatus(run.status)) return `Browser view was not on for run ${runId}`;
		if (!(await isBrowserViewPending(run))) return `Browser view is not on for run ${runId}`;
		if (isCancelled() || Date.now() >= deadline) return `The display mirror of run ${runId} did not start in time`;
		await new Promise((resolve) => setTimeout(resolve, VNC_CONNECT_RETRY_MS));
	}
}

/** A live run with the toggle on but no mirror address yet: `services/runs.ts` writes it once the sidecar
 * is up, a moment after the run id exists. */
export async function isBrowserViewPending(run: RunRecord): Promise<boolean> {
	if (run.localBrowserView || isTerminalJobStatus(run.status)) return false;
	const actor = await getActorById(run.actorId);
	return actor?.localBrowserView !== undefined;
}

async function handleConnection(ws: WebSocket, runId: string): Promise<void> {
	// An `'error'` with no listener crashes the process.
	ws.on('error', () => undefined);

	let closed = false;
	ws.once('close', () => {
		closed = true;
	});

	const run = await awaitMirroredRun(runId, () => closed);
	if (typeof run === 'string') {
		if (!closed) ws.close(1008, run);
		return;
	}

	const socket = await dialWithRetry(run.localBrowserView.vncHost, run.localBrowserView.vncPort, () => closed);
	if (!socket) {
		if (!closed) ws.close(1011, `The display mirror of run ${runId} is not reachable`);
		return;
	}
	if (closed) {
		socket.destroy();
		return;
	}

	ws.on('message', (data) => {
		if (!socket.destroyed) socket.write(toBuffer(data));
	});
	socket.on('data', (chunk: Buffer) => {
		if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
	});
	socket.on('error', () => undefined);
	// The run ending removes the sidecar, which closes the TCP side.
	socket.once('close', () => {
		if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
			ws.close(1000, `The display mirror of run ${runId} has gone away`);
		}
	});
	ws.once('close', () => socket.destroy());
}

export function attachBrowserViewWebSocket(server: Server): BrowserViewWebSocketServer {
	const wss = new WebSocketServer({ noServer: true });

	server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		const pathname = req.url ? new URL(req.url, 'http://localhost').pathname : undefined;
		const runId = pathname ? extractBrowserViewRunId(pathname) : undefined;
		if (!runId) {
			socket.destroy();
			return;
		}

		wss.handleUpgrade(req, socket, head, (ws) => {
			void handleConnection(ws, runId).catch(() => {
				ws.terminate();
			});
		});
	});

	return {
		close() {
			for (const client of wss.clients) client.terminate();
			wss.close();
		},
	};
}
