/**
 * The platform's last-run shortcuts - `v2/actors/:actorId/runs/last` and everything under it (`api.md`'s
 * "Last-run shortcuts"): one `router.all` route for every method and sub-path, mirroring apify-core's
 * `routes/actors/last_run.ts` plus `lib/controllers.ts: routeToLastRunRoutes`. The Actor is resolved, the
 * caller's newest run of it picked (narrowed by `?status=` / `?origin=` when given), and the request is
 * then re-dispatched through the whole app with its URL rewritten onto that run's own endpoint - so every
 * sub-path answers exactly as the same request with the run id spelled out would: same methods, same body
 * shapes, same error types, and the same `501`/`404` for a sub-path this runtime does not serve.
 *
 * Source consistency with the upstream fallback (`services/api-fallback.ts`): the Actor lookup is the one
 * and only point at which this request can still leave the runtime. An Actor unknown here throws
 * `record-not-found` *before* anything else is looked up, so `fallbackNotFoundEnabled` relays the caller's
 * original URL as a whole and the platform resolves the Actor, its last run and the sub-resource itself.
 * An Actor found here pins the request to this runtime (`pinRequestToLocal`) before the run is even looked
 * for: from then on every miss - no run yet, no such record key, `501` on `key-value-store/records` - is
 * answered locally, whatever the toggles say. A local Actor never gets a platform run; a platform Actor
 * never gets local storages.
 */
import type { Request, Response, Router } from 'express';

import { requireUser } from '../auth.js';
import { sendError } from '../envelope.js';
import { endpointNotFound, invalidRequest, recordNotFound } from '../errors.js';
import { h } from '../handler.js';
import { resolveOwnedActor } from '../../services/actors.js';
import { pinRequestToLocal } from '../../services/api-fallback.js';
import { findLastOwnedRun } from '../../services/runs.js';
import type { RunRecord } from '../../storage/entities.js';

/** `@apify/consts`'s `ACTOR_JOB_STATUSES` - the platform's `?status=` vocabulary, deliberately wider than
 * this runtime's own `JobStatus` (`TIMING-OUT` never occurs here): the platform validates the *value*, not
 * whether the Actor ever had such a run, so an accepted-but-never-local status simply finds no run. */
const ACTOR_JOB_STATUSES: ReadonlySet<string> = new Set([
	'READY',
	'RUNNING',
	'SUCCEEDED',
	'FAILED',
	'TIMING-OUT',
	'TIMED-OUT',
	'ABORTING',
	'ABORTED',
]);

/** `@apify/consts`'s `META_ORIGINS`, same reasoning; every run this runtime starts is `API`. */
const META_ORIGINS: ReadonlySet<string> = new Set([
	'DEVELOPMENT',
	'WEB',
	'API',
	'SCHEDULER',
	'TEST',
	'WEBHOOK',
	'ACTOR',
	'CLI',
	'STANDBY',
	'CI',
	'MCP',
	'APIFY_AI',
]);

/** apify-core's `invalidStatusParameter` / `invalidOriginParameter`, message included: a present value
 * outside the platform's vocabulary (or a repeated one, which Express parses as an array) is `400` - before
 * the Actor is looked up, so it is also never relayed. An absent parameter is simply no filter. */
function filterParam(req: Request, key: 'status' | 'origin', allowed: ReadonlySet<string>): string | undefined {
	const raw = req.query[key];
	if (raw === undefined) return undefined;
	if (typeof raw !== 'string' || !allowed.has(raw)) {
		throw invalidRequest(
			key === 'status' ? 'Status parameter has an invalid value' : 'Origin parameter has an invalid value',
		);
	}
	return raw;
}

/** The sub-paths the platform's `getRunRoute` knows (`lib/controllers.ts`), and nothing else. */
const NO_SUCH_SHORTCUT =
	'There is no last-run endpoint at this URL. The Apify API serves runs/last, runs/last/log, ' +
	'runs/last/dataset/*, runs/last/key-value-store/*, runs/last/request-queue/*, runs/last/abort, ' +
	'runs/last/reboot and runs/last/metamorph.';

/**
 * Where a `runs/last` request re-dispatches to - apify-core's `getRunRoute`, as a pure function of the
 * router-relative URL (`/actors/:actorId/runs/last[/prefix[/rest...]][?query]`) and the picked run.
 * Throws `not-found` for a sub-path the platform has no last-run form for.
 *
 * Works off the raw URL, never `req.params`: the sub-path is forwarded byte for byte, percent-encoding and
 * query string included, so a record key or `?stream=true` reaches the target route exactly as the caller
 * sent it. Positional (segments four onward), so the route's own case-insensitive matching of
 * `actors`/`runs`/`last` can't confuse it. `?status=`/`?origin=` ride along in the query string like on the
 * platform; every target route ignores them.
 */
export function lastRunTargetUrl(method: string, url: string, run: RunRecord): string {
	const queryStart = url.indexOf('?');
	const pathname = queryStart === -1 ? url : url.slice(0, queryStart);
	const search = queryStart === -1 ? '' : url.slice(queryStart);
	const [prefix, ...rest] = pathname.split('/').filter(Boolean).slice(4);
	const tail = rest.length > 0 ? `/${rest.join('/')}` : '';

	switch (prefix) {
		case undefined:
			// The platform serves the bare form from `GET v2/actors/:actorId/runs/:runId`, a GET-only route.
			// This runtime's equivalent run object lives at `v2/actor-runs/:runId`, which also takes `DELETE` -
			// a write the platform's shortcut never offers, so every method but `GET` stops here instead.
			if (method !== 'GET' && method !== 'HEAD') {
				throw endpointNotFound('runs/last itself is GET-only; there is no last-run endpoint for this method');
			}
			return `/v2/actor-runs/${run.id}${search}`;
		case 'log':
			// Exactly `logs/:runId`, like the platform - anything after `log` is dropped. Unlike the platform,
			// which also drops the query string here (turning `?stream=true` into a plain one-shot read), the
			// query string is kept, so streaming and `?token=` authentication keep working.
			return `/v2/logs/${run.id}${search}`;
		case 'key-value-store':
			return `/v2/key-value-stores/${run.defaultKeyValueStoreId}${tail}${search}`;
		case 'dataset':
			return `/v2/datasets/${run.defaultDatasetId}${tail}${search}`;
		case 'request-queue':
			return `/v2/request-queues/${run.defaultRequestQueueId}${tail}${search}`;
		case 'abort':
		case 'metamorph':
		case 'reboot':
			return `/v2/actor-runs/${run.id}/${prefix}${tail}${search}`;
		default:
			throw endpointNotFound(NO_SUCH_SHORTCUT);
	}
}

/**
 * apify-core's `routeToLastRunRoutes` re-entry, `res.app.handle(req, res)`: the request goes back through
 * the whole app with a new `req.url`, and the target route answers with its own status, body and error
 * types - its `record-not-found`/`501`/`404` all pass `server.ts`'s fallback seams too, where they are
 * declined, since `pinRequestToLocal` already ran. `req.originalUrl` is untouched (Express sets it once per
 * request), so the fallback's own logging still names the URL the caller sent. `req.baseUrl` is reset to
 * the root: the router left this handler's `/v2` mount in it, and the re-entry would otherwise prefix it a
 * second time. `auth()` runs again on the way in - a cache hit for this token (`services/users.ts`) - and
 * the raw body parser is a no-op the second time round (`req._body`), so the rewritten request carries the
 * same user and the same body.
 */
function redispatch(req: Request, res: Response, url: string): void {
	req.url = url;
	req.baseUrl = '';
	res.app(req, res, (error?: unknown) => {
		// Unreachable by construction: `server.ts` ends the stack with a catch-all that answers every request
		// and an error middleware that answers every error. Kept so a future wiring change cannot hang the
		// response - Express's default `finalhandler` is what a bare `res.app.handle(req, res)` would fall to.
		console.error(`last-run: re-dispatch of ${req.method} ${req.originalUrl} fell through the app`, error);
		if (!res.headersSent) sendError(res, 500, 'internal-error', 'Internal error');
	});
}

export function mountLastRun(router: Router): void {
	router.all(
		'/actors/:actorId/runs/last{/*rest}',
		h(async (req, res) => {
			const status = filterParam(req, 'status', ACTOR_JOB_STATUSES);
			const origin = filterParam(req, 'origin', META_ORIGINS);

			const user = requireUser(req);
			const actor = await resolveOwnedActor(user.id, req.params.actorId as string, user.username);
			// The one miss on this route the fallback may act on - see the module doc comment.
			if (!actor) throw recordNotFound();
			pinRequestToLocal(req);

			const run = await findLastOwnedRun(user.id, actor.id, { status, origin });
			if (!run) throw recordNotFound('Actor run was not found');

			redispatch(req, res, lastRunTargetUrl(req.method, req.url, run));
		}),
	);
}
