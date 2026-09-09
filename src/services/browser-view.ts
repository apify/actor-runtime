/**
 * Per-Actor browser view (`actor-driver.md`'s "Browser view" section): a read-only (or, opted in,
 * interactive) live mirror of the X display a run's browser draws on, served by the console. Like
 * `debug-mode.ts`, `setBrowserView` is the single validate-and-persist entry point shared by the API route
 * and the console form; everything here is pure bookkeeping and text - the sidecar itself lives in
 * `driver/docker-driver.ts`.
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

/**
 * Single validate-and-persist path for both the API and console form. Enabling fully replaces
 * `localBrowserView` - an omitted `interactive` resets to `false` rather than keeping its prior value.
 * Writes bypass `services/actors.ts: updateActor`, so toggling never bumps `modifiedAt`.
 */
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

/** Read-back shared by the API's toggle response and the console detail page (no separate `GET`). */
export function browserViewStatus(actor: Pick<ActorRecord, 'localBrowserView'>): BrowserViewStatus {
	if (!actor.localBrowserView) return { localBrowserView: null };
	return { localBrowserView: { interactive: actor.localBrowserView.interactive } };
}

/** The console page that renders a run's live mirror (`console.md`'s "Browser view page"). */
export function browserViewPageUrl(runId: string): string {
	return `${CONSOLE_BASE_URL}/runs/${encodeURIComponent(runId)}/browser`;
}

/** The run log's one browser-view line, written by `services/runs.ts` once the sidecar is up and before
 * the Actor's own container is created. */
export function browserViewLogLine(runId: string, interactive: boolean): string {
	const mode = interactive
		? 'interactive - mouse and keyboard input from the viewer is delivered to the display'
		: 'view-only - the viewer can watch but never sends input';
	return (
		`Browser view: this run's X display is mirrored live at ${browserViewPageUrl(runId)} (${mode}). ` +
		`The mirror only reads the display's framebuffer through the shared /tmp/.X11-unix socket directory - ` +
		`the Actor's container, command, environment, network and the browser itself are exactly what they ` +
		`are without it, whether or not anyone is watching. A headless browser draws nothing on the display: ` +
		`run it headful to see it (Crawlee: \`headless: false\` in the crawler options, or CRAWLEE_HEADLESS=0).\n`
	);
}

/** Message for a run whose browser-view sidecar could not be started, built from the driver's rejection.
 * Returns the bare reason with no `Cannot start run: ` prefix - `services/runs.ts` adds that. */
export function describeBrowserViewerStartFailure(actorId: string, error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error);
	return (
		`browser view is on for this Actor, but its display mirror could not be started: ${reason} ` +
		`Clear browser view with \`apify api POST /actor-runtime/browser-view/${actorId} --body '{"enabled": false}'\` ` +
		`to run without it.`
	);
}
