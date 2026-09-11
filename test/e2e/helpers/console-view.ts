import WebSocket from 'ws';

/** The console's own base URL, as `startRuntimeContainer` publishes it. */
export const CONSOLE_URL = 'http://localhost:3000';

/**
 * Opens the console's viewer websocket for the run and resolves with the first bytes the mirror sends: an
 * RFB server's `ProtocolVersion` greeting (`RFB 003.008\n`), which x11vnc sends the moment a client
 * connects - proof that the bridge reached a live VNC server mirroring the run's display, before any
 * handshake. The console bridge itself keeps re-dialing the sidecar until the Actor's Xvfb is up, so one
 * connection attempt is enough; the timeout here just bounds that wait.
 *
 * This is `requirements/test.md`'s documented browser-view exception to the CLI-only rule - emulating a
 * developer's browser opening the view, which no `apify` command can express.
 */
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
