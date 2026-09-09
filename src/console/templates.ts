/** Minimal server-rendered HTML helpers. No SPA, no bundler, no build step (`console.md`). */

import { getApiFallbackState, type ApiFallbackState } from '../services/api-fallback.js';
import type { ActorLocalBrowserView, ActorLocalDebug, RunRecord } from '../storage/entities.js';

export function escapeHtml(value: unknown): string {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

const NAV = [
	['/actors', 'Actors'],
	['/builds', 'Builds'],
	['/runs', 'Runs'],
	['/logs', 'Logs'],
	['/datasets', 'Datasets'],
	['/key-value-stores', 'Key-value stores'],
	['/request-queues', 'Request queues'],
] as const;

function onOff(enabled: boolean): 'on' | 'off' {
	return enabled ? 'on' : 'off';
}

/** The final nav entry, present on every page (`console.md`'s "header state indicator") - "Settings"
 * plus both fallback toggles' current state, so neither toggle can ever be on without being visible from
 * anywhere in the console. Read fresh on every render, straight from `services/api-fallback.ts` - the
 * one module both the API route and the `/settings` form write through - never threaded in as an
 * argument, so this needs no change to `layout()`'s signature or any of its call sites. */
function fallbackNavEntry(): string {
	const state = getApiFallbackState();
	const label = `Settings — fallback (unimplemented: ${onOff(state.fallbackUnimplementedEnabled)}, not-found: ${onOff(state.fallbackNotFoundEnabled)})`;
	return `<a href="/settings">${label}</a>`;
}

export function layout(title: string, body: string): string {
	const nav = [...NAV.map(([href, label]) => `<a href="${href}">${label}</a>`), fallbackNavEntry()].join(' | ');
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} - actor-runtime console</title>
<style>
	body { font-family: -apple-system, sans-serif; margin: 2rem; color: #1a1a1a; }
	nav { margin-bottom: 1.5rem; padding-bottom: 0.5rem; border-bottom: 1px solid #ccc; }
	nav a { margin-right: 0.5rem; text-decoration: none; color: #0b5fff; }
	table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
	th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; font-size: 0.9rem; }
	th { background: #f5f5f5; }
	dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
	dt { font-weight: 600; }
	pre { background: #f5f5f5; padding: 1rem; overflow-x: auto; white-space: pre-wrap; }
	.empty { color: #777; font-style: italic; }
	.error { color: #b00020; }
	.warning { color: #94600b; }
	.wide-input { width: 28rem; }
	h1 { margin-top: 0; }
	.browser-view-screen { width: 100%; height: 75vh; background: #222; }
	.browser-view-screen canvas { outline: none; }
</style>
</head>
<body>
<nav>${nav}</nav>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>`;
}

/** A table cell (or definition-list value) rendered as a link to another console page. */
export interface LinkedCell {
	text: string;
	href: string;
}

function renderValue(value: unknown): string {
	if (value !== null && typeof value === 'object' && 'href' in value) {
		const { text, href } = value as LinkedCell;
		return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
	}
	return escapeHtml(value);
}

export function table(
	headers: string[],
	rows: Array<Array<string | LinkedCell>>,
	linkColumn = 0,
	linkPrefix = '',
): string {
	if (rows.length === 0) return '<p class="empty">Nothing here yet.</p>';
	const head = `<tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr>`;
	const body = rows
		.map((row) => {
			const cells = row
				.map((cell, i) =>
					i === linkColumn && linkPrefix && typeof cell === 'string'
						? `<td><a href="${linkPrefix}/${encodeURIComponent(cell)}">${escapeHtml(cell)}</a></td>`
						: `<td>${renderValue(cell)}</td>`,
				)
				.join('');
			return `<tr>${cells}</tr>`;
		})
		.join('');
	return `<table>${head}${body}</table>`;
}

/** The dev-folder registration form on the Actor detail view - a single text field plus a submit
 * button, styled via this file's shared `<style>` block (`.error`/`.wide-input`/`.empty`), matching
 * every other console page's convention of no inline `style=` attributes. */
export function devFolderForm(actorId: string, currentValue: string, errorMessage?: string): string {
	const errorHtml = errorMessage ? `<p class="error"><strong>Error:</strong> ${escapeHtml(errorMessage)}</p>` : '';
	return (
		errorHtml +
		`<form method="post" action="/actors/${encodeURIComponent(actorId)}/dev-folder">` +
		`<input type="text" name="localDevFolder" value="${escapeHtml(currentValue)}" ` +
		'placeholder="/abs/path/to/src" class="wide-input"> ' +
		'<button type="submit">Save</button>' +
		'</form>' +
		'<p class="empty">Submit an empty value to clear the registration.</p>'
	);
}

/** The debug-mode toggle form on the Actor detail view - full parity with the API body's three fields
 * (`enabled`/`language`/`port`), submitted together, never a partial-merge PATCH.
 *
 * `current` must be the *raw stored* `ActorLocalDebug`, not `debugStatus`'s display-computed value:
 * rendering the computed default port would pre-fill the port input, so an unrelated resubmission would
 * silently persist it as an explicit override. */
export function debugModeForm(
	actorId: string,
	current: ActorLocalDebug | null | undefined,
	errorMessage?: string,
): string {
	const errorHtml = errorMessage ? `<p class="error"><strong>Error:</strong> ${escapeHtml(errorMessage)}</p>` : '';
	const language = current?.language ?? 'auto';
	const portValue = current?.port !== undefined ? String(current.port) : '';
	const option = (value: string, label: string) =>
		`<option value="${value}"${language === value ? ' selected' : ''}>${label}</option>`;
	return (
		errorHtml +
		`<form method="post" action="/actors/${encodeURIComponent(actorId)}/debug">` +
		`<label><input type="checkbox" name="enabled"${current ? ' checked' : ''}> enabled</label> ` +
		`<label>language: <select name="language">` +
		option('auto', 'auto') +
		option('node', 'node') +
		option('python', 'python') +
		'</select></label> ' +
		`<label>port: <input type="number" name="port" value="${escapeHtml(portValue)}" min="1024" max="65535" ` +
		'placeholder="(default)"></label> ' +
		'<button type="submit">Save</button>' +
		'</form>' +
		'<p class="empty">Uncheck "enabled" and submit to turn debug mode off. Leave "port" blank to use the ' +
		"resolved language's own default port (5678 Python / 9229 Node) at run start.</p>"
	);
}

/** The browser-view toggle form; both API fields, submitted together like `debugModeForm`. */
export function browserViewForm(
	actorId: string,
	current: ActorLocalBrowserView | null | undefined,
	errorMessage?: string,
): string {
	const errorHtml = errorMessage ? `<p class="error"><strong>Error:</strong> ${escapeHtml(errorMessage)}</p>` : '';
	return (
		errorHtml +
		`<form method="post" action="/actors/${encodeURIComponent(actorId)}/browser-view">` +
		`<label><input type="checkbox" name="enabled"${current ? ' checked' : ''}> enabled</label> ` +
		`<label><input type="checkbox" name="interactive"${current?.interactive ? ' checked' : ''}> interactive ` +
		'(deliver mouse/keyboard input from the viewer)</label> ' +
		'<button type="submit">Save</button>' +
		'</form>' +
		'<p class="empty">When on, every run of this Actor gets a live mirror of its display, linked from the ' +
		"run's page. The browser must run headful to show anything (Crawlee JS: <code>headless: false</code>, " +
		'Python: <code>headless=False</code>).</p>'
	);
}

/** The viewer page: noVNC (served under `/vendor/novnc/`) connected to `console/browser-view-ws.ts`. The
 * run id is embedded as a JSON literal with `<` escaped so it cannot break out of the script element. */
export function browserViewPage(
	run: RunRecord & { localBrowserView: NonNullable<RunRecord['localBrowserView']> },
): string {
	const runIdLiteral = JSON.stringify(run.id).replace(/</g, '\\u003c');
	const viewOnly = run.localBrowserView.interactive ? 'false' : 'true';
	const mode = run.localBrowserView.interactive ? 'interactive' : 'view-only';
	return (
		`<p>Live mirror of the X display of run <a href="/runs/${encodeURIComponent(run.id)}">${escapeHtml(run.id)}</a> ` +
		`(${mode}). ` +
		(run.localBrowserView.interactive
			? 'Your mouse and keyboard input is delivered to the display. Nothing else is: no clipboard, no data to the Actor. '
			: 'Nothing is sent to the display, the browser, or the Actor: no input, no clipboard. ') +
		'The picture is read from the display the browser draws on.</p>' +
		'<p id="browser-view-status" class="empty">Connecting…</p>' +
		'<div id="browser-view-screen" class="browser-view-screen"></div>' +
		`<script type="module">
import RFB from '/vendor/novnc/core/rfb.js';
const runId = ${runIdLiteral};
const viewOnly = ${viewOnly};
const status = document.getElementById('browser-view-status');
const screen = document.getElementById('browser-view-screen');
const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
const url = scheme + '://' + location.host + '/runs/' + encodeURIComponent(runId) + '/browser/ws';
let attempts = 0;
function connect() {
	attempts += 1;
	status.textContent = attempts === 1 ? 'Connecting…' : 'Reconnecting (attempt ' + attempts + ')…';
	const rfb = new RFB(screen, url, { shared: true });
	rfb.viewOnly = viewOnly;
	rfb.scaleViewport = true;
	rfb.background = '#222';
	rfb.addEventListener('connect', () => {
		attempts = 0;
		status.textContent = "Connected - live view of the run's display" + (viewOnly ? ' (view-only).' : ' (interactive).') +
			' A black picture means nothing is drawn on the display: the browser is running headless. Launch it with headless off (Crawlee JS: headless: false; Python: headless=False).';
	});
	rfb.addEventListener('disconnect', () => {
		if (attempts >= 40) {
			status.textContent = 'Disconnected - the run has ended, or its display never came up. Reload to try again.';
			return;
		}
		status.textContent = 'Disconnected - the display is not up yet or went away; retrying…';
		setTimeout(connect, 3000);
	});
}
connect();
</script>`
	);
}

/** Rendered only for a `RUNNING` run (`console.md`, "Migrate button"). */
export function migrateRunForm(runId: string): string {
	return (
		`<form method="post" action="/runs/${encodeURIComponent(runId)}/migrate">` +
		'<button type="submit">Migrate</button>' +
		'</form>' +
		'<p class="empty">Emulates a platform migration: sends the <code>migrating</code> event, stops the ' +
		'container a few seconds later (immediately if the Actor reboots itself), and restarts the same run. ' +
		'Reload this page to watch the log and stats change.</p>'
	);
}

/** The one-line credential-forwarding warning the `/settings` page shows above its form
 * (`console.md`'s "Settings page" section) - both toggles forward the caller's own Apify token the
 * moment either is on, so this is shown unconditionally, not only once a toggle is already on. */
export function apiFallbackWarning(): string {
	return '<p class="warning">Enabling either option below forwards the caller\'s own Apify token to the upstream API shown above.</p>';
}

/** The `/settings` page's one form (`console.md`): two checkboxes, one submit, always submitting both
 * checkboxes' current state together - an unchecked box is simply absent from the submitted body, which
 * the POST route (`console/server.ts`) reads as `false` for that field, never as "leave unchanged" (the
 * console form's own single-submit contract, unlike the API route's genuinely partial `POST`). */
export function settingsForm(state: ApiFallbackState): string {
	const checkedAttr = (enabled: boolean) => (enabled ? ' checked' : '');
	return (
		'<form method="post" action="/settings">' +
		'<p><label><input type="checkbox" name="fallbackUnimplementedEnabled"' +
		checkedAttr(state.fallbackUnimplementedEnabled) +
		'> Fall back for unimplemented endpoints</label></p>' +
		'<p><label><input type="checkbox" name="fallbackNotFoundEnabled"' +
		checkedAttr(state.fallbackNotFoundEnabled) +
		'> Fall back for not-found records</label></p>' +
		'<button type="submit">Save</button>' +
		'</form>'
	);
}

export function definitionList(fields: Array<[string, unknown]>): string {
	const rows = fields.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${renderValue(value)}</dd>`).join('');
	return `<dl>${rows}</dl>`;
}
