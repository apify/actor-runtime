/** `POST /actor-runtime/browser-view/:actorId` - the browser-view toggle, same shape and scoping as `debug-mode.ts`. */
import type { Router } from 'express';

import { requireUser } from '../auth.js';
import { sendData } from '../envelope.js';
import { invalidRequest, recordNotFound } from '../errors.js';
import { h, jsonBody } from '../handler.js';
import { browserViewStatus, setBrowserView } from '../../services/browser-view.js';
import { resolveOwnedActor } from '../../services/actors.js';

export function mountBrowserView(router: Router): void {
	router.post(
		'/browser-view/:actorId',
		h(async (req, res) => {
			const user = requireUser(req);
			const actor = await resolveOwnedActor(user.id, req.params.actorId as string, user.username);
			if (!actor) throw recordNotFound();

			const raw = jsonBody<unknown>(req);
			const result = await setBrowserView(actor, raw);
			if (result.kind !== 'ok') throw invalidRequest(result.message);

			sendData(res, browserViewStatus(result.actor));
		}),
	);
}
