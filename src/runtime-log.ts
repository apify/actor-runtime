/**
 * How a log line written by the runtime itself looks, so it is never mistaken for the Actor's own
 * output: a blue `[actor-runtime]` marker (textual too, so it survives the colors being stripped).
 * Only the marker and any URL are colored - coloring whole messages makes a log harder to read. The
 * one exception is `tone: 'error'`, below.
 *
 * Per line, never once around a chunk: `services/logs.ts` stamps each line with its own timestamp, so
 * a span left open across a newline would swallow the next line's stamp.
 *
 * `docker/sitecustomize.py` and `docker/browser-viewer.sh` run inside containers and hand-write these
 * same bytes.
 */

export const RUNTIME_LOG_PREFIX = '[actor-runtime]';

const BLUE = '\x1b[34m';
const BOLD_BLUE = '\x1b[1;34m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const BOLD_RED = '\x1b[1;31m';
const RESET = '\x1b[0m';

/** Trailing sentence punctuation is left out: `browser.` must not colour the period into the link. */
const URL_PATTERN = /https?:\/\/[^\s]*[^\s.,;:!?)\]}'"]/g;

/** `emphasis` is bold (loud warnings, section rules), not a color of its own: the marker's blue means
 * "the runtime wrote this", not a severity. `tone: 'error'` is the one red message: the runtime
 * explaining, after a run has failed, why it failed and what to do - it has to stand out from the
 * stack trace above it. The marker keeps its blue either way. */
export interface RuntimeLogLine {
	text: string;
	emphasis?: boolean;
	tone?: 'error';
}

export interface RuntimeLogStyle {
	emphasis?: boolean;
	tone?: 'error';
}

function styleSegment(segment: string, code: string): string {
	return segment === '' ? '' : `${code}${segment}${RESET}`;
}

/** The code for the prose of a line, or `undefined` for the terminal default. */
function textStyle({ emphasis, tone }: RuntimeLogStyle): string | undefined {
	if (tone === 'error') return emphasis ? BOLD_RED : RED;
	return emphasis ? BOLD : undefined;
}

/** Each segment resets its own style rather than leaving one open: one missed restore after a link
 * would restyle everything after it. */
function formatMessage(message: string, style: RuntimeLogStyle): string {
	const linkStyle = style.emphasis ? BOLD_BLUE : BLUE;
	const prose = textStyle(style);
	const styleProse = (segment: string) => (prose ? styleSegment(segment, prose) : segment);
	let out = '';
	let from = 0;
	for (const match of message.matchAll(URL_PATTERN)) {
		const at = match.index;
		out += styleProse(message.slice(from, at));
		out += styleSegment(match[0], linkStyle);
		from = at + match[0].length;
	}
	return out + styleProse(message.slice(from));
}

function formatLine(line: string, style: RuntimeLogStyle): string {
	// A blank separator line inside a section stays blank - nothing to mark.
	if (line === '') return '';
	return `${styleSegment(RUNTIME_LOG_PREFIX, style.emphasis ? BOLD_BLUE : BLUE)} ${formatMessage(line, style)}`;
}

/** `text` may contain any number of newlines and may or may not end with one; the result always ends
 * with exactly one, so a runtime message never shares a line with the Actor's next print. */
export function formatRuntimeLog(text: string, options: RuntimeLogStyle = {}): string {
	const withoutTrailingNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
	return `${withoutTrailingNewline
		.split('\n')
		.map((line) => formatLine(line, options))
		.join('\n')}\n`;
}

/** One chunk (one `appendLog` call), so nothing interleaves into the middle of the block. */
export function formatRuntimeLogLines(lines: readonly RuntimeLogLine[]): string {
	return lines.map(({ text, emphasis, tone }) => formatRuntimeLog(text, { emphasis, tone })).join('');
}
