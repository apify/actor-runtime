import { describe, expect, it } from 'vitest';
import { formatRuntimeLog, formatRuntimeLogLines, RUNTIME_LOG_PREFIX } from '../../src/runtime-log.js';
import { ansiToHtml } from '../../src/console/ansi.js';

const ESC = '\x1b';
const BLUE = `${ESC}[34m`;
const BOLD_BLUE = `${ESC}[1;34m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;

const MARKER = `${BLUE}${RUNTIME_LOG_PREFIX}${RESET}`;
const BOLD_MARKER = `${BOLD_BLUE}${RUNTIME_LOG_PREFIX}${RESET}`;

describe('formatRuntimeLog', () => {
	it('colors the prefix and leaves the message itself in the terminal default', () => {
		expect(formatRuntimeLog('Cannot start run: Docker is not available')).toBe(
			`${MARKER} Cannot start run: Docker is not available\n`,
		);
	});

	it('accepts text that already ends with a newline without doubling it', () => {
		expect(formatRuntimeLog('Dockerfile not found, using the default one.\n')).toBe(
			`${MARKER} Dockerfile not found, using the default one.\n`,
		);
	});

	it('renders an emphasized line with a bold blue prefix and a bold message', () => {
		expect(formatRuntimeLog('!! Running in `Live dev folder mode`', { emphasis: true })).toBe(
			`${BOLD_MARKER} ${BOLD}!! Running in \`Live dev folder mode\`${RESET}\n`,
		);
	});

	it('colors a URL inside the message so the link stands out from the prose around it', () => {
		expect(
			formatRuntimeLog('Browser view: live mirror at http://localhost:3000/runs/r1/browser (view-only).'),
		).toBe(
			`${MARKER} Browser view: live mirror at ${BLUE}http://localhost:3000/runs/r1/browser${RESET} (view-only).\n`,
		);
	});

	it('leaves sentence punctuation after a URL out of the link', () => {
		expect(formatRuntimeLog('See http://localhost:3000/runs/r1.')).toBe(
			`${MARKER} See ${BLUE}http://localhost:3000/runs/r1${RESET}.\n`,
		);
	});

	it('restores bold after a link on an emphasized line instead of leaving the rest unstyled', () => {
		expect(formatRuntimeLog('open http://localhost:3000/x now', { emphasis: true })).toBe(
			`${BOLD_MARKER} ${BOLD}open ${RESET}${BOLD_BLUE}http://localhost:3000/x${RESET}${BOLD} now${RESET}\n`,
		);
	});

	it('opens and resets every span within one line, so a per-line timestamp can never land inside one', () => {
		const formatted = formatRuntimeLog('first\nsecond\n');

		expect(formatted).toBe(`${MARKER} first\n${MARKER} second\n`);
		// No span stays open across a newline, which keeps `services/logs.ts`'s stamps uncolored.
		for (const line of formatted.split('\n').filter((l) => l.length > 0)) {
			expect(line.startsWith(MARKER)).toBe(true);
			expect(line.slice(MARKER.length)).not.toContain(ESC);
		}
	});

	it('leaves a blank separator line blank rather than prefixing an empty message', () => {
		expect(formatRuntimeLog('one\n\ntwo')).toBe(`${MARKER} one\n\n${MARKER} two\n`);
	});

	it('identifies the runtime even with every escape byte stripped - the marker is textual, not only visual', () => {
		// eslint-disable-next-line no-control-regex
		const withoutAnsi = formatRuntimeLog('Browser view: ...').replace(/\x1b\[[0-9;]*m/g, '');
		expect(withoutAnsi).toBe(`${RUNTIME_LOG_PREFIX} Browser view: ...\n`);
	});
});

describe('formatRuntimeLogLines', () => {
	it('renders a block whose emphasis differs line by line as one chunk', () => {
		expect(
			formatRuntimeLogLines([
				{ text: '==== Local Actor runtime ====', emphasis: true },
				{ text: 'Live dev folder: /src' },
			]),
		).toBe(`${BOLD_MARKER} ${BOLD}==== Local Actor runtime ====${RESET}\n` + `${MARKER} Live dev folder: /src\n`);
	});
});

describe('runtime lines in the console log views', () => {
	it("render the marker and links in the console palette's dark blue, the message as plain text", () => {
		const html = ansiToHtml(`${formatRuntimeLog('see http://localhost:3000/runs/r1/browser now')}actor output\n`);

		expect(html).toBe(
			`<span style="color:#1565c0">${RUNTIME_LOG_PREFIX}</span> see ` +
				'<span style="color:#1565c0">http://localhost:3000/runs/r1/browser</span> now\nactor output\n',
		);
	});
});
