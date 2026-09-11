/**
 * The one place that decides how a log line written by the *runtime itself* looks.
 *
 * A build/run log interleaves two very different voices: the Actor's own output, and the runtime's
 * commentary about it (dev-folder mounts, debug-mode attach addresses, browser-view URLs, migration
 * markers, "cannot start run" failures). Reading such a log must never leave any doubt about which
 * line came from which, so every runtime-authored line carries the same two markers:
 *
 * - a literal `[actor-runtime]` prefix, which survives the colors being stripped - a log piped into a
 *   file, read through `grep`, or rendered by a terminal without color support still says plainly
 *   where the line came from; and
 * - ANSI blue (SGR `34`, bold blue for emphasized lines). No level of the Apify/Crawlee loggers an
 *   Actor prints through renders a whole line in blue, so a runtime line stays visually distinct in
 *   the middle of a noisy Actor log. The console's log views map the same code to a dark blue
 *   (`console/ansi.ts`), so the distinction survives there too, and the `/v2/logs/:id` API keeps
 *   serving the raw bytes for the CLI to render itself (`requirements/console.md`).
 *
 * Formatting happens per *line*, never once around a whole multi-line chunk: `services/logs.ts`
 * stamps every log line with its own ISO timestamp at the line start (`requirements/api.md`), so a
 * color span left open across a newline would put the next line's timestamp inside it. Each line is
 * therefore colored and reset on its own, leaving the timestamps uncolored and the platform's log
 * format untouched.
 */

/** Prefix identifying a runtime-authored line, deliberately readable with colors stripped. */
export const RUNTIME_LOG_PREFIX = '[actor-runtime]';

const BLUE = '\x1b[34m';
const BOLD_BLUE = '\x1b[1;34m';
const RESET = '\x1b[0m';

/** One line of runtime-authored log text. `emphasis` renders it in bold (loud warnings, section
 * rules); the color is the same either way - runtime lines never change color by severity, that is
 * exactly what makes the color mean "this is the runtime talking". */
export interface RuntimeLogLine {
	text: string;
	emphasis?: boolean;
}

function formatLine(line: string, emphasis: boolean | undefined): string {
	// An empty line stays empty: prefixing it would add a marker with nothing to mark, and the blank
	// line is usually there as a separator inside a runtime section.
	if (line === '') return '';
	return `${emphasis ? BOLD_BLUE : BLUE}${RUNTIME_LOG_PREFIX} ${line}${RESET}`;
}

/**
 * Formats runtime-authored text for `appendLog`/`onLog`: every line prefixed and colored, with a
 * trailing newline guaranteed so a runtime message never shares a line with whatever the Actor prints
 * next. `text` may contain any number of newlines and may or may not end with one.
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
