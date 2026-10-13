/** `POST /actor-runtime/browser-view/:actorId` - the browser-view toggle, same shape and scoping as `debug-mode.ts`. */
import type { Router } from 'express';

import { sendData } from '../envelope.js';
import { invalidRequest, recordNotFound } from '../errors.js';
import { h, jsonBody } from '../handler.js';
import { browserViewStatus, setBrowserView } from '../../services/browser-view.js';
import { resolveActorParam } from '../resolve-reference.js';

export function mountBrowserView(router: Router): void {
	router.post(
		'/browser-view/:actorId',
		h(async (req, res) => {
			const actor = await resolveActorParam(req);
			if (!actor) throw recordNotFound();

			const raw = jsonBody<unknown>(req);
			const result = await setBrowserView(actor, raw);
			if (result.kind !== 'ok') throw invalidRequest(result.message);

			sendData(res, browserViewStatus(result.actor));
		}),
	);
}
