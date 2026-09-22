/**
 * Resolves which input schema a build should carry from the version's `sourceFiles` - the build-time
 * half of input validation (`actor-driver.md`'s "Input schema, validation and defaults"). The run-time
 * half (defaults, validation) lives in `services/input-schema.ts` and reads only the schema this module
 * resolved, never the source files again.
 *
 * Candidate order, stopping at the first hit, matching what `apify-cli` itself looks for locally (its
 * `readInputSchema`), which is also what the platform's builder records on the build:
 *   1. the `input` field of `.actor/actor.json` - an inline schema object, or a path relative to
 *      `.actor/`
 *   2. `.actor/INPUT_SCHEMA.json`
 *   3. `INPUT_SCHEMA.json` at the Actor root
 * Matching is case-insensitive with an exact-case win, exactly like `services/dockerfile-location.ts`
 * (so `.actor/input_schema.json` and `.actor/INPUT_SCHEMA.json` are the same candidate - which is why
 * the CLI's four-entry list collapses to the two locations above here), and every outcome is stated in
 * the build log.
 *
 * `.actor/actor.json` and the schema file alike are parsed as JSON5, matching how this runtime already
 * parses `.actor/actor.json` for the Dockerfile lookup; every valid JSON file is also valid JSON5, so
 * this only ever accepts more than the platform, never less.
 */
import * as path from 'node:path';
import JSON5 from 'json5';

import { normalizeEntryName } from '../driver/tar-entry-name.js';
import type { InputSchema, SourceFile } from '../storage/entities.js';
import { describeInputSchemaDefect } from './input-schema.js';

const ACTOR_DIR = '.actor';
const ACTOR_JSON_NAME = `${ACTOR_DIR}/actor.json`;
/** Checked case-insensitively, so the `INPUT_SCHEMA.json` spelling matches these too. */
const DEFAULT_SCHEMA_CANDIDATES = [`${ACTOR_DIR}/input_schema.json`, 'input_schema.json'] as const;

/** Why input-schema resolution failed. Each one fails the build, the same way the Dockerfile
 * resolution's own failures do - an Actor whose declared input contract cannot be read is not built
 * with that contract silently dropped. */
export type InputSchemaResolutionFailureReason =
	'escapes-actor-root' | 'invalid-input-field' | 'unparseable-input-schema' | 'invalid-input-schema';

/** `resolveInputSchemaLocation`'s outcomes: `resolved` (a candidate matched and the schema is valid),
 * `none` (no candidate at all - the Actor simply has no input schema, which is not an error), or
 * `failure`. */
export type InputSchemaResolution =
	| { outcome: 'resolved'; schema: InputSchema; source: string; logLines: string[] }
	| { outcome: 'none'; logLines: string[] }
	| { outcome: 'failure'; reason: InputSchemaResolutionFailureReason; message: string };

function sourceFileToText(file: SourceFile): string {
	return file.format === 'BASE64' ? Buffer.from(file.content, 'base64').toString('utf8') : file.content;
}

/** Exact-case match wins; otherwise the first match in `sourceFiles` order - same rule as
 * `services/dockerfile-location.ts`'s own lookup. */
function findCaseInsensitive(sourceFiles: SourceFile[], candidate: string): SourceFile | undefined {
	const lowerCandidate = candidate.toLowerCase();
	let firstMatch: SourceFile | undefined;
	for (const file of sourceFiles) {
		const normalizedName = normalizeEntryName(file.name);
		if (normalizedName.toLowerCase() !== lowerCandidate) continue;
		if (normalizedName === candidate) return file;
		firstMatch ??= file;
	}
	return firstMatch;
}

/** `.actor/actor.json`'s own path is not case-folded, unlike the schema candidates. */
function findExact(sourceFiles: SourceFile[], normalizedTarget: string): SourceFile | undefined {
	return sourceFiles.find((file) => normalizeEntryName(file.name) === normalizedTarget);
}

function escapesActorRootFailure(rawField: string): InputSchemaResolution {
	return {
		outcome: 'failure',
		reason: 'escapes-actor-root',
		message: `Input schema path "${rawField}" in .actor/actor.json points outside the Actor root directory.`,
	};
}

/** Meta-validates a resolved candidate, turning it into the `resolved`/`failure` outcome. Kept in one
 * place so an inline `input` object and a schema file are held to exactly the same standard. */
function acceptSchema(schema: unknown, source: string, logLines: string[]): InputSchemaResolution {
	const defect = describeInputSchemaDefect(schema);
	if (defect) {
		return {
			outcome: 'failure',
			reason: 'invalid-input-schema',
			message: `Input schema from ${source} is not valid: ${defect}`,
		};
	}
	return {
		outcome: 'resolved',
		schema: schema as InputSchema,
		source,
		logLines: [...logLines, `Using the input schema from ${source}.\n`],
	};
}

export function resolveInputSchemaLocation(sourceFiles: SourceFile[]): InputSchemaResolution {
	const logLines: string[] = [];

	const actorJsonFile = findExact(sourceFiles, ACTOR_JSON_NAME);
	let actorSpecification: unknown;
	if (actorJsonFile) {
		try {
			actorSpecification = JSON5.parse(sourceFileToText(actorJsonFile));
		} catch {
			// Deliberately not a failure of its own: `services/dockerfile-location.ts` runs first on the
			// very same file and already fails the build with its own "Could not parse .actor/actor.json"
			// message, so reporting it twice (in two different wordings) would only be noise.
			actorSpecification = undefined;
		}
	}

	if (actorSpecification !== null && typeof actorSpecification === 'object' && 'input' in actorSpecification) {
		const field: unknown = actorSpecification.input;

		// An inline schema object, the other shape the Actor specification allows for this field.
		if (field !== null && typeof field === 'object' && !Array.isArray(field)) {
			return acceptSchema(field, 'the "input" field in .actor/actor.json', logLines);
		}

		if (typeof field !== 'string') {
			return {
				outcome: 'failure',
				reason: 'invalid-input-field',
				message: '.actor/actor.json has invalid format: "input" must be a string or an object.',
			};
		}

		if (field === '') {
			logLines.push(
				'Warning: "" (from the "input" field in .actor/actor.json) is not in the pushed source; falling back to the default locations.\n',
			);
		} else if (field.startsWith('/')) {
			return escapesActorRootFailure(field);
		} else {
			const joined = normalizeEntryName(path.posix.join(ACTOR_DIR, field));
			if (joined === '..' || joined.startsWith('../')) {
				return escapesActorRootFailure(field);
			}

			const match = findCaseInsensitive(sourceFiles, joined);
			if (match) {
				const parsed = parseSchemaFile(match);
				if (parsed.outcome === 'failure') return parsed;
				return acceptSchema(
					parsed.schema,
					`"${normalizeEntryName(match.name)}" (the "input" field in .actor/actor.json)`,
					logLines,
				);
			}

			// A value naming no pushed file falls through to the default locations instead of failing -
			// the same tolerance `apify-cli` shows locally (it warns and keeps looking), and the same one
			// the Dockerfile field already has here.
			logLines.push(
				`Warning: "${joined}" (from the "input" field in .actor/actor.json) is not in the pushed source; falling back to the default locations.\n`,
			);
		}
	}

	for (const candidate of DEFAULT_SCHEMA_CANDIDATES) {
		const match = findCaseInsensitive(sourceFiles, normalizeEntryName(candidate));
		if (!match) continue;
		const parsed = parseSchemaFile(match);
		if (parsed.outcome === 'failure') return parsed;
		return acceptSchema(parsed.schema, `"${normalizeEntryName(match.name)}"`, logLines);
	}

	// No input schema at all is the normal state of an Actor that never declared one - runs of such a
	// build take their input exactly as the caller sent it, with nothing validated and nothing added.
	return { outcome: 'none', logLines };
}

type SchemaFileParse = { outcome: 'parsed'; schema: unknown } | Extract<InputSchemaResolution, { outcome: 'failure' }>;

function parseSchemaFile(file: SourceFile): SchemaFileParse {
	try {
		return { outcome: 'parsed', schema: JSON5.parse(sourceFileToText(file)) as unknown };
	} catch (error) {
		return {
			outcome: 'failure',
			reason: 'unparseable-input-schema',
			message: `Could not parse the input schema "${normalizeEntryName(file.name)}": ${(error as Error).message}`,
		};
	}
}
