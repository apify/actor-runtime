import { describe, expect, it } from 'vitest';
import { formatRuntimeLog, formatRuntimeLogLines, RUNTIME_LOG_PREFIX } from '../../src/runtime-log.js';
import { ansiToHtml } from '../../src/console/ansi.js';

const ESC = '\x1b';
const BLUE = `${ESC}[34m`;
const BOLD_BLUE = `${ESC}[1;34m`;
const RESET = `${ESC}[0m`;

describe('formatRuntimeLog', () => {
	it('prefixes and colors a single line, always ending with exactly one newline', () => {
		expect(formatRuntimeLog('Cannot start run: Docker is not available')).toBe(
			`${BLUE}${RUNTIME_LOG_PREFIX} Cannot start run: Docker is not available${RESET}\n`,
		);
	});

	it('accepts text that already ends with a newline without doubling it', () => {
		expect(formatRuntimeLog('Dockerfile not found, using the default one.\n')).toBe(
			`${BLUE}${RUNTIME_LOG_PREFIX} Dockerfile not found, using the default one.${RESET}\n`,
		);
	});

	it('renders bold blue for an emphasized line, same color as a plain one', () => {
		expect(formatRuntimeLog('!! Running in `Live dev folder mode`', { emphasis: true })).toBe(
			`${BOLD_BLUE}${RUNTIME_LOG_PREFIX} !! Running in \`Live dev folder mode\`${RESET}\n`,
		);
	});

	it('colors and resets each line of a multi-line message separately, so a per-line timestamp can never land inside a color span', () => {
		const formatted = formatRuntimeLog('first\nsecond\n');

		expect(formatted).toBe(
			`${BLUE}${RUNTIME_LOG_PREFIX} first${RESET}\n${BLUE}${RUNTIME_LOG_PREFIX} second${RESET}\n`,
		);
		// Every line starts outside any escape sequence: the runtime never leaves a span open across a
		// newline, which is what keeps `services/logs.ts`'s line stamps outside the coloring.
		for (const line of formatted.split('\n').filter((l) => l.length > 0)) {
			expect(line.startsWith(ESC)).toBe(true);
			expect(line.endsWith(RESET)).toBe(true);
		}
	});

	it('leaves a blank separator line blank rather than prefixing an empty message', () => {
		expect(formatRuntimeLog('one\n\ntwo')).toBe(
			`${BLUE}${RUNTIME_LOG_PREFIX} one${RESET}\n\n${BLUE}${RUNTIME_LOG_PREFIX} two${RESET}\n`,
		);
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
		).toBe(
			`${BOLD_BLUE}${RUNTIME_LOG_PREFIX} ==== Local Actor runtime ====${RESET}\n` +
				`${BLUE}${RUNTIME_LOG_PREFIX} Live dev folder: /src${RESET}\n`,
		);
	});
});

describe('runtime lines in the console log views', () => {
	it("render as the console palette's dark blue, distinct from Actor output around them", () => {
		const html = ansiToHtml(`${formatRuntimeLog('runtime says this')}actor says this\n`);

		expect(html).toBe(
			`<span style="color:#1565c0">${RUNTIME_LOG_PREFIX} runtime says this</span>\nactor says this\n`,
		);
	});
});
