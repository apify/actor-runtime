/**
 * Per-Actor browser view: a live mirror of the X display a run's browser draws on. Like `debug-mode.ts`,
 * `setBrowserView` is the single validate-and-persist entry point for the API route and the console form.
 */
import type { ActorLocalBrowserView, ActorRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import { CONSOLE_BASE_URL } from '../config.js';

const ALLOWED_FIELDS = ['enabled', 'interactive'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validation result; `message` is reused verbatim by the API's 400 response and the console's inline error. */
export type ValidatedBrowserViewBody =
	{ kind: 'ok'; enabled: boolean; interactive: boolean } | { kind: 'invalid'; message: string };

/** Strict-object body validation only; never touches the registry - `setBrowserView` below does that. */
export function validateBrowserViewBody(body: unknown): ValidatedBrowserViewBody {
	if (!isPlainObject(body)) {
		return { kind: 'invalid', message: 'Request body must be a JSON object' };
	}

	const unknownKey = Object.keys(body).find((key) => !(ALLOWED_FIELDS as readonly string[]).includes(key));
	if (unknownKey) {
		return {
			kind: 'invalid',
			message: `Unknown field "${unknownKey}" - allowed fields are "enabled", "interactive".`,
		};
	}

	if (typeof body.enabled !== 'boolean') {
		return { kind: 'invalid', message: '"enabled" must be a boolean' };
	}

	if (body.interactive !== undefined && typeof body.interactive !== 'boolean') {
		return { kind: 'invalid', message: '"interactive" must be a boolean' };
	}

	return { kind: 'ok', enabled: body.enabled, interactive: body.interactive ?? false };
}

async function writeLocalBrowserView(
	actorId: string,
	localBrowserView: ActorLocalBrowserView | undefined,
): Promise<ActorRecord | null> {
	return getRegistries().actors.update(actorId, (current) => (current ? { ...current, localBrowserView } : current));
}

export type SetBrowserViewResult = { kind: 'ok'; actor: ActorRecord } | { kind: 'invalid'; message: string };

/** Enabling fully replaces `localBrowserView` (an omitted `interactive` resets to `false`). Writes bypass
 * `updateActor`, so toggling never bumps `modifiedAt`. */
export async function setBrowserView(actor: ActorRecord, rawBody: unknown): Promise<SetBrowserViewResult> {
	const parsed = validateBrowserViewBody(rawBody);
	if (parsed.kind === 'invalid') return parsed;

	if (!parsed.enabled) {
		if (!actor.localBrowserView) return { kind: 'ok', actor };
		const updated = await writeLocalBrowserView(actor.id, undefined);
		return { kind: 'ok', actor: updated ?? { ...actor, localBrowserView: undefined } };
	}

	const localBrowserView: ActorLocalBrowserView = { interactive: parsed.interactive };
	const updated = await writeLocalBrowserView(actor.id, localBrowserView);
	return { kind: 'ok', actor: updated ?? { ...actor, localBrowserView } };
}

export interface BrowserViewStatus {
	/** `null` when browser view is off (never toggled on, or explicitly cleared) for this Actor. */
	localBrowserView: { interactive: boolean } | null;
}

/** Read-back for the API response and the console page (no separate `GET`). */
export function browserViewStatus(actor: Pick<ActorRecord, 'localBrowserView'>): BrowserViewStatus {
	if (!actor.localBrowserView) return { localBrowserView: null };
	return { localBrowserView: { interactive: actor.localBrowserView.interactive } };
}

export function browserViewPageUrl(runId: string): string {
	return `${CONSOLE_BASE_URL}/runs/${encodeURIComponent(runId)}/browser`;
}

/** The run log's browser-view line, written before the Actor's container is created. */
export function browserViewLogLine(runId: string, interactive: boolean): string {
	return (
		`Browser view: live mirror of this run's display at ${browserViewPageUrl(runId)} ` +
		`(${interactive ? 'interactive' : 'view-only'}). Only the display's pixels are read; the Actor and its ` +
		`browser are unaffected. A headless browser draws nothing - run it headful ` +
		`(Crawlee JS: headless: false; Python: headless=False).\n`
	);
}

/** No `Cannot start run: ` prefix - `services/runs.ts` adds it. */
export function describeBrowserViewerStartFailure(actorId: string, error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error);
	return (
		`browser view is on for this Actor, but its display mirror could not be started: ${reason} ` +
		`Clear browser view with \`apify api POST /actor-runtime/browser-view/${actorId} --body '{"enabled": false}'\` ` +
		`to run without it.`
	);
}
