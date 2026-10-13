/**
 * A run's `meta.origin` (`api.md`'s "Actor run origin"): the platform's `META_ORIGINS` from `@apify/consts`,
 * and the `X-Apify-Request-Origin` header its API takes the origin from (apify-core's
 * `request_origin_parser` middleware) - the Apify CLI sends `CLI` (`CI` under CI), this runtime's own webhook
 * dispatcher sends `WEBHOOK`.
 */
import type { Request } from 'express';

export const REQUEST_ORIGIN_HEADER = 'x-apify-request-origin';

export const META_ORIGINS = [
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
] as const;

export type MetaOrigin = (typeof META_ORIGINS)[number];

export const DEFAULT_RUN_ORIGIN: MetaOrigin = 'API';

export function isMetaOrigin(value: unknown): value is MetaOrigin {
	return typeof value === 'string' && (META_ORIGINS as readonly string[]).includes(value);
}

/** The origin a run started by `req` gets: the header's value when it is one the platform knows, `API`
 * otherwise - an unknown value is ignored, never an error, as on the platform. */
export function requestOrigin(req: Request): MetaOrigin {
	const header = req.header(REQUEST_ORIGIN_HEADER);
	return isMetaOrigin(header) ? header : DEFAULT_RUN_ORIGIN;
}
