/**
 * `POST /actor-runtime/browser-view/:actorId` - the local-only browser-view toggle (`actor-driver.md`'s
 * "Browser view" section), on the same `/actor-runtime` sub-router as `debug-mode.ts` (both mounts, shared
 * `auth()` - see `server.ts`).
 *
 * Canonical body is a strict JSON object: `{"enabled": true}` (view-only), `{"enabled": true,
 * "interactive": true}`, or `{"enabled": false}` to clear - any other shape (an unknown field included) is
 * `400 invalid-request` (`api.md`). Ownership-scoped exactly like `debug-mode.ts`.
 */
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

			// The response body doubles as the read-back - no separate `GET`, same as the debug endpoint.
			sendData(res, browserViewStatus(result.actor));
		}),
	);
}
