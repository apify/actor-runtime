import WebSocket from 'ws';

export const CONSOLE_URL = 'http://localhost:3000';

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
