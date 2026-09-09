/**
 * The browser-view websocket bridge: `GET /runs/:runId/browser/ws`, upgraded on the console server
 * directly (Express does not handle `upgrade`), the way `api/events-ws.ts` does on the API server. It
 * bridges the noVNC client on the console's viewer page (`console.md`'s "Browser view page") to the run's
 * x11vnc sidecar over the `apify-local` network - the runtime itself plays websockify, so the sidecar
 * needs no websocket server and no port is ever published on the host (`system.md`).
 *
 * Unauthenticated like the rest of the console; the path's run id is the only thing it scopes on, and a
 * connection only ever reaches that run's own sidecar. A run without a mirror (toggle off, or the sidecar
 * failed) or an already-ended run gets a completed upgrade followed by a `1008` close with a reason, so the
 * viewer page can show why.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { connect, type Socket } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import { getRunById } from '../services/runs.js';
import { isTerminalJobStatus } from '../services/job-status.js';

// A trailing slash is a different path, not a second spelling of this one.
const BROWSER_VIEW_WS_PATH_PATTERN = /^\/runs\/([^/]+)\/browser\/ws$/;

/** The sidecar only starts x11vnc once the Actor's X server has created its socket, which can be a while
 * after the run starts (image pull, Node startup, Xvfb start). A viewer that connects earlier gets its
 * TCP dial to the sidecar retried within this budget rather than an immediate failure. */
const VNC_CONNECT_TIMEOUT_MS = 120_000;
const VNC_CONNECT_RETRY_MS = 500;

export interface BrowserViewWebSocketServer {
	/** Same contract as `EventsWebSocketServer.close()`: terminates every open connection so
	 * `closeServer(consoleServer)` cannot hang on one. */
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

/** Dials the sidecar until it answers, `isCancelled()` says stop, or the budget runs out (resolves
 * `undefined` in the latter two cases - never rejects). */
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

async function handleConnection(ws: WebSocket, runId: string): Promise<void> {
	// Must come first: an `'error'` with no listener crashes the process (see `api/events-ws.ts`).
	ws.on('error', () => undefined);

	const run = await getRunById(runId);
	if (!run) {
		ws.close(1008, `Unknown run id: ${runId}`);
		return;
	}
	if (!run.localBrowserView) {
		ws.close(1008, `Browser view is not on for run ${runId}`);
		return;
	}
	if (isTerminalJobStatus(run.status)) {
		ws.close(1008, `Run ${runId} has already ended`);
		return;
	}

	let closed = false;
	ws.once('close', () => {
		closed = true;
	});
	const socket = await dialWithRetry(run.localBrowserView.vncHost, run.localBrowserView.vncPort, () => closed);
	if (!socket) {
		if (!closed) ws.close(1011, `The display mirror of run ${runId} is not reachable`);
		return;
	}
	if (closed) {
		socket.destroy();
		return;
	}

	// Plain byte pump in both directions - RFB frames are opaque to the bridge.
	ws.on('message', (data) => {
		if (!socket.destroyed) socket.write(toBuffer(data));
	});
	socket.on('data', (chunk: Buffer) => {
		if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
	});
	socket.on('error', () => undefined);
	// The sidecar is removed when the run ends (`services/runs.ts`), which is what ends the TCP side.
	socket.once('close', () => {
		if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
			ws.close(1000, `The display mirror of run ${runId} has gone away`);
		}
	});
	ws.once('close', () => socket.destroy());
}

/** Registers the upgrade handler on the console server and returns a handle shutdown can close. */
export function attachBrowserViewWebSocket(server: Server): BrowserViewWebSocketServer {
	const wss = new WebSocketServer({ noServer: true });

	server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		const pathname = req.url ? new URL(req.url, 'http://localhost').pathname : undefined;
		const runId = pathname ? extractBrowserViewRunId(pathname) : undefined;
		if (!runId) {
			// Not this endpoint's path, and this is the console server's only 'upgrade' listener.
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
