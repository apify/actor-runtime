/** Pure-logic coverage for `services/browser-view.ts` - body validation, read-back shaping, and the
 * user-facing text - no storage, no Docker. */
import { describe, expect, it } from 'vitest';

import {
	browserViewLogLine,
	browserViewPageUrl,
	browserViewStatus,
	describeBrowserViewerStartFailure,
	validateBrowserViewBody,
} from '../../src/services/browser-view.js';

describe('validateBrowserViewBody', () => {
	it('accepts {"enabled": true}, defaulting interactive to false', () => {
		expect(validateBrowserViewBody({ enabled: true })).toEqual({ kind: 'ok', enabled: true, interactive: false });
	});

	it('accepts an explicit interactive flag', () => {
		expect(validateBrowserViewBody({ enabled: true, interactive: true })).toEqual({
			kind: 'ok',
			enabled: true,
			interactive: true,
		});
	});

	it('accepts {"enabled": false} (a clear), ignoring nothing else - interactive still defaults', () => {
		expect(validateBrowserViewBody({ enabled: false })).toEqual({ kind: 'ok', enabled: false, interactive: false });
	});

	it('rejects a non-object body', () => {
		for (const body of [null, 'true', 42, [true], undefined]) {
			const result = validateBrowserViewBody(body);
			expect(result.kind).toBe('invalid');
			expect((result as { message: string }).message).toContain('JSON object');
		}
	});

	it('rejects an unknown field by name, listing the allowed ones', () => {
		const result = validateBrowserViewBody({ enabled: true, interactve: true });
		expect(result).toEqual({
			kind: 'invalid',
			message: 'Unknown field "interactve" - allowed fields are "enabled", "interactive".',
		});
	});

	it('rejects a missing or non-boolean enabled', () => {
		expect(validateBrowserViewBody({})).toEqual({ kind: 'invalid', message: '"enabled" must be a boolean' });
		expect(validateBrowserViewBody({ enabled: 'yes' })).toEqual({
			kind: 'invalid',
			message: '"enabled" must be a boolean',
		});
	});

	it('rejects a non-boolean interactive', () => {
		expect(validateBrowserViewBody({ enabled: true, interactive: 1 })).toEqual({
			kind: 'invalid',
			message: '"interactive" must be a boolean',
		});
	});
});

describe('browserViewStatus', () => {
	it('is null when the toggle is off', () => {
		expect(browserViewStatus({})).toEqual({ localBrowserView: null });
		expect(browserViewStatus({ localBrowserView: undefined })).toEqual({ localBrowserView: null });
	});

	it('echoes the stored interactive flag when on', () => {
		expect(browserViewStatus({ localBrowserView: { interactive: true } })).toEqual({
			localBrowserView: { interactive: true },
		});
	});
});

describe('user-facing text', () => {
	it('the page URL points at the console on its fixed port, run id encoded', () => {
		expect(browserViewPageUrl('run a/b')).toBe('http://localhost:3000/runs/run%20a%2Fb/browser');
	});

	it('the run-log line names the page URL, the mode, and that the Actor is unaffected', () => {
		const viewOnly = browserViewLogLine('run-1', false);
		expect(viewOnly).toContain('http://localhost:3000/runs/run-1/browser');
		expect(viewOnly).toContain('view-only');
		expect(viewOnly).toContain('unaffected');
		expect(viewOnly).toContain('headless: false');
		expect(viewOnly.endsWith('\n')).toBe(true);

		const interactive = browserViewLogLine('run-1', true);
		expect(interactive).toContain('interactive');
		expect(interactive).not.toContain('view-only');
	});

	it('the start-failure text carries the driver reason and the exact clear command for this Actor', () => {
		const text = describeBrowserViewerStartFailure('actor-xyz', new Error('payload is missing.'));
		expect(text).toContain('payload is missing.');
		expect(text).toContain(`apify api POST /actor-runtime/browser-view/actor-xyz --body '{"enabled": false}'`);
		expect(text.startsWith('Cannot start run')).toBe(false);
	});
});
