/**
 * Which input schema a build carries, resolved from the version's `sourceFiles`
 * (`actor-driver.md`'s "Input schema, validation and defaults"). The run-time half - defaults and
 * validation - is `services/input-schema.ts`, which reads only the resolved schema, never the source
 * files again.
 *
 * The candidate order is `apify-cli`'s own `readInputSchema`, so a developer's local `apify
 * validate-schema` and this build agree on which file is the Actor's schema. Case-insensitive matching
 * (as in `services/dockerfile-location.ts`) is why the CLI's four candidates collapse to two here.
 *
 * Schema files are parsed as JSON5, like `.actor/actor.json` already is: every valid JSON file is
 * valid JSON5, so this only ever accepts more than the platform, never less.
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

/** Why resolution failed. Each one fails the build: an Actor whose declared input contract cannot be
 * read must not be built with that contract silently dropped. */
export type InputSchemaResolutionFailureReason =
	'escapes-actor-root' | 'invalid-input-field' | 'unparseable-input-schema' | 'invalid-input-schema';

/** `none` means the Actor declares no input schema, which is not an error. */
export type InputSchemaResolution =
	| { outcome: 'resolved'; schema: InputSchema; source: string; logLines: string[] }
	| { outcome: 'none'; logLines: string[] }
	| { outcome: 'failure'; reason: InputSchemaResolutionFailureReason; message: string };

function sourceFileToText(file: SourceFile): string {
	return file.format === 'BASE64' ? Buffer.from(file.content, 'base64').toString('utf8') : file.content;
}

/** Exact-case match wins; otherwise the first match in `sourceFiles` order - the same rule as the
 * Dockerfile lookup's. */
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

/** One place, so an inline `input` object and a schema file are held to the same standard. */
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
