/** A Dockerfile reduced to the instructions the process driver executes. */
export interface Instruction {
	keyword: string;
	/** Leading `--flag[=value]` options, e.g. `--from=build`. */
	flags: Record<string, string>;
	/** The rest of the line, verbatim. */
	args: string;
}

export function parseDockerfile(text: string): Instruction[] {
	const logical: string[] = [];
	let pending = '';
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!pending && (line === '' || line.startsWith('#'))) continue;
		if (pending && line.startsWith('#')) continue;
		if (line.endsWith('\\')) {
			pending += `${line.slice(0, -1)} `;
			continue;
		}
		logical.push(pending + line);
		pending = '';
	}
	if (pending) logical.push(pending.trim());

	return logical.map((line) => {
		const match = /^(\S+)\s*([\s\S]*)$/.exec(line)!;
		let args = match[2]!;
		const flags: Record<string, string> = {};
		for (;;) {
			const flag = /^--([a-z-]+)(?:=(\S+))?\s*/i.exec(args);
			if (!flag) break;
			flags[flag[1]!.toLowerCase()] = flag[2] ?? '';
			args = args.slice(flag[0].length);
		}
		return { keyword: match[1]!.toUpperCase(), flags, args };
	});
}

/** `["a","b"]` exec form, or `undefined` for shell form. */
export function parseExecForm(args: string): string[] | undefined {
	if (!args.startsWith('[')) return undefined;
	try {
		const parsed: unknown = JSON.parse(args);
		return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? (parsed as string[]) : undefined;
	} catch {
		return undefined;
	}
}

/** `$NAME` and `${NAME}` (with `${NAME:-default}`) against `vars`; unknown names expand to ''. */
export function expandVariables(text: string, vars: Record<string, string>): string {
	return text.replace(
		/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g,
		(_m, braced, fallback, bare) => {
			const value = vars[braced ?? bare];
			return value !== undefined && value !== '' ? value : (fallback ?? '');
		},
	);
}

/** Splits `ENV`/`ARG`-style arguments: `K=V K2="v 2"` or the legacy `K V`. */
export function parseKeyValues(args: string): Array<[string, string | undefined]> {
	if (!/^\S+=/.test(args) && /^\S+\s+\S/.test(args)) {
		const [key, ...rest] = args.split(/\s+/);
		return [[key!, rest.join(' ')]];
	}
	const pairs: Array<[string, string | undefined]> = [];
	const pattern = /(\S+?)(?:=("(?:[^"\\]|\\.)*"|'[^']*'|\S*))?(?:\s+|$)/g;
	for (const m of args.matchAll(pattern)) {
		if (!m[1]) continue;
		pairs.push([m[1], m[2] === undefined ? undefined : m[2].replace(/^["']|["']$/g, '')]);
	}
	return pairs;
}
