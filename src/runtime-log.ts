/**
 * The one place that decides how a log line written by the *runtime itself* looks.
 *
 * A build/run log interleaves two very different voices: the Actor's own output, and the runtime's
 * commentary about it (dev-folder mounts, debug-mode attach addresses, browser-view URLs, migration
 * markers, "cannot start run" failures). Reading such a log must never leave any doubt about which
 * line came from which, so every runtime-authored line opens with the same marker:
 *
 * - a literal `[actor-runtime]` prefix, which survives the colors being stripped - a log piped into a
 *   file, read through `grep`, or rendered by a terminal without color support still says plainly
 *   where the line came from; and
 * - ANSI blue (SGR `34`, bold blue for emphasized lines) on that prefix. Only the prefix is colored,
 *   not the message after it: the eye needs one colored marker per line to find the runtime's lines,
 *   and coloring whole paragraphs of prose only makes the log harder to read. The one exception is a
 *   URL inside the message, which is colored too so it can be picked out (and clicked) at a glance.
 *   The console's log views map the same code to a dark blue (`console/ansi.ts`), so the distinction
 *   survives there too, and the `/v2/logs/:id` API keeps serving the raw bytes for the CLI to render
 *   itself (`requirements/console.md`).
 *
 * Formatting happens per *line*, never once around a whole multi-line chunk: `services/logs.ts`
 * stamps every log line with its own ISO timestamp at the line start (`requirements/api.md`), so a
 * color span left open across a newline would put the next line's timestamp inside it. Every span is
 * therefore opened and reset within one line, leaving the timestamps uncolored and the platform's log
 * format untouched.
 */

/** Prefix identifying a runtime-authored line, deliberately readable with colors stripped. */
export const RUNTIME_LOG_PREFIX = '[actor-runtime]';

const BLUE = '\x1b[34m';
const BOLD_BLUE = '\x1b[1;34m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/** `http(s)` URLs the runtime prints (viewer pages, docs). Trailing sentence punctuation is left out
 * of the match - `(view-only).` and `browser.` must not colour the period as part of the link. */
const URL_PATTERN = /https?:\/\/[^\s]*[^\s.,;:!?)\]}'"]/g;

/** One line of runtime-authored log text. `emphasis` renders it in bold (loud warnings, section
 * rules); the color is the same either way - runtime lines never change color by severity, that is
 * exactly what makes the color mean "this is the runtime talking". */
export interface RuntimeLogLine {
	text: string;
	emphasis?: boolean;
}

/** Each segment carries its own SGR sequence and its own reset, rather than leaving one style open
 * across the rest of the line: a URL in the middle of an emphasized line would otherwise have to
 * restore bold afterwards, and one missed restore silently restyles everything that follows. */
function styleSegment(segment: string, code: string): string {
	return segment === '' ? '' : `${code}${segment}${RESET}`;
}

/** The message after the prefix: plain (or bold, when emphasized), with any URL in it colored. */
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
	// An empty line stays empty: prefixing it would add a marker with nothing to mark, and the blank
	// line is usually there as a separator inside a runtime section.
	if (line === '') return '';
	return `${styleSegment(RUNTIME_LOG_PREFIX, emphasis ? BOLD_BLUE : BLUE)} ${formatMessage(line, emphasis)}`;
}

/**
 * Formats runtime-authored text for `appendLog`/`onLog`: every line prefixed with the runtime's
 * colored marker, with a trailing newline guaranteed so a runtime message never shares a line with
 * whatever the Actor prints next. `text` may contain any number of newlines and may or may not end
 * with one.
 */
export function formatRuntimeLog(text: string, options: { emphasis?: boolean } = {}): string {
	const withoutTrailingNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
	return `${withoutTrailingNewline
		.split('\n')
		.map((line) => formatLine(line, options.emphasis))
		.join('\n')}\n`;
}

/** `formatRuntimeLog` for a block of lines whose emphasis differs line by line, rendered as one chunk
 * (one `appendLog` call) so nothing can interleave into the middle of it. */
export function formatRuntimeLogLines(lines: readonly RuntimeLogLine[]): string {
	return lines.map(({ text, emphasis }) => formatRuntimeLog(text, { emphasis })).join('');
}
