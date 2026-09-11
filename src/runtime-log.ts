/**
 * How a log line written by the runtime itself looks, so it is never mistaken for the Actor's own
 * output: a blue `[actor-runtime]` marker (textual too, so it survives the colors being stripped).
 * Only the marker and any URL are colored - coloring whole messages makes a log harder to read.
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
const RESET = '\x1b[0m';

/** Trailing sentence punctuation is left out: `browser.` must not colour the period into the link. */
const URL_PATTERN = /https?:\/\/[^\s]*[^\s.,;:!?)\]}'"]/g;

/** `emphasis` is bold (loud warnings, section rules) - never a different color: the color means "the
 * runtime wrote this", not a severity. */
export interface RuntimeLogLine {
	text: string;
	emphasis?: boolean;
}

function styleSegment(segment: string, code: string): string {
	return segment === '' ? '' : `${code}${segment}${RESET}`;
}

/** Each segment resets its own style rather than leaving one open: one missed restore after a link
 * would restyle everything after it. */
function formatMessage(message: string, emphasis: boolean | undefined): string {
	const linkStyle = emphasis ? BOLD_BLUE : BLUE;
	let out = '';
	let from = 0;
	for (const match of message.matchAll(URL_PATTERN)) {
		const at = match.index;
		out += emphasis ? styleSegment(message.slice(from, at), BOLD) : message.slice(from, at);
		out += styleSegment(match[0], linkStyle);
		from = at + match[0].length;
	}
	const tail = message.slice(from);
	return out + (emphasis ? styleSegment(tail, BOLD) : tail);
}

function formatLine(line: string, emphasis: boolean | undefined): string {
	// A blank separator line inside a section stays blank - nothing to mark.
	if (line === '') return '';
	return `${styleSegment(RUNTIME_LOG_PREFIX, emphasis ? BOLD_BLUE : BLUE)} ${formatMessage(line, emphasis)}`;
}

/** `text` may contain any number of newlines and may or may not end with one; the result always ends
 * with exactly one, so a runtime message never shares a line with the Actor's next print. */
export function formatRuntimeLog(text: string, options: { emphasis?: boolean } = {}): string {
	const withoutTrailingNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
	return `${withoutTrailingNewline
		.split('\n')
		.map((line) => formatLine(line, options.emphasis))
		.join('\n')}\n`;
}

/** One chunk (one `appendLog` call), so nothing interleaves into the middle of the block. */
export function formatRuntimeLogLines(lines: readonly RuntimeLogLine[]): string {
	return lines.map(({ text, emphasis }) => formatRuntimeLog(text, { emphasis })).join('');
}
