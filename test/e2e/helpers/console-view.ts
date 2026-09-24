import WebSocket from 'ws';

export const CONSOLE_URL = 'http://localhost:3000';

/**
 * A GET of a console page. Retried once when the request went out on a keep-alive connection the other
 * side had already closed - as a browser retries it - since rootless Podman's port forwarder can keep
 * the client's end of an idle connection open after the console closed its own.
 */
export async function fetchConsole(path: string): Promise<Response> {
	try {
		return await fetch(`${CONSOLE_URL}${path}`);
	} catch (error) {
		if ((error as { cause?: { code?: string } }).cause?.code !== 'UND_ERR_SOCKET') throw error;
		return fetch(`${CONSOLE_URL}${path}`);
	}
}

/** Resolves with x11vnc's `ProtocolVersion` greeting - proof the bridge reached a live VNC server
 * mirroring the run's display. `test.md`'s documented exception to the CLI-only rule. */
export function readMirrorGreeting(runId: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${CONSOLE_URL.replace('http', 'ws')}/runs/${runId}/browser/ws`);
		const timer = setTimeout(() => {
			ws.terminate();
			reject(new Error('Timed out waiting for the RFB greeting over the viewer websocket'));
		}, timeoutMs);
		ws.once('message', (data) => {
			clearTimeout(timer);
			ws.close();
			resolve(Buffer.from(data as Buffer).toString('latin1'));
		});
		ws.once('close', (code, reason) => {
			clearTimeout(timer);
			reject(new Error(`Viewer websocket closed before any data: ${code} ${reason.toString()}`));
		});
		ws.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}
