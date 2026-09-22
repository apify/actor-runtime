/**
 * Input validation and defaults from the Actor's input schema - the run-time half of the feature whose
 * build-time half (finding the schema in the pushed source) is `services/input-schema-location.ts`.
 *
 * Validation itself is the platform's own: `@apify/input_schema`'s `validateInputSchema` (the schema
 * against the Apify input-schema meta-schema) and `validateInputUsingValidator` (the input against the
 * schema, plus the proxy/`requestListSources`/pattern checks AJV alone cannot express), driven by the
 * same AJV configuration the platform's API uses. That is deliberate: a developer must see locally the
 * very same message the real API would answer with, not an approximation of it.
 *
 * Two behaviours the platform has and this runtime deliberately does not:
 *   - **Proxy group availability.** The platform passes the caller's proxy groups into the validator,
 *     which then rejects a group the account cannot use. This runtime emulates no proxy groups at all
 *     (`unsupported.md`), so it passes none: a `proxy` field is still checked for shape, custom proxy
 *     URLs and country code, but any `apifyProxyGroups` selection is accepted.
 *   - **Encrypted secret input fields** stay unsupported (`unsupported.md`); a schema may declare
 *     `isSecret`, and the value is then validated as the plain value it locally is.
 */
import ajvPackage from 'ajv';
import ajv2019Package from 'ajv/dist/2019.js';
import { validateInputSchema, validateInputUsingValidator } from '@apify/input_schema';

import type { InputSchema } from '../storage/entities.js';

// AJV ships as CommonJS, so under this package's ESM resolution its class arrives as the module's
// `default` rather than as the import binding itself. `2019` is the same library built with
// draft-2019-09 support, which the Apify input-schema meta-schema requires and the plain build lacks.
const Ajv = ajvPackage.default;
const Ajv2019 = ajv2019Package.default;
type InputValidator = ReturnType<InstanceType<typeof Ajv>['compile']>;

/** The Actor input as it travels from the API route into the run: the exact bytes stored as the run's
 * `INPUT` record, with the content type they are stored under. */
export interface ActorInput {
	body: Buffer;
	contentType: string;
}

/** Every way `processActorInput` can end, `ok` included - a discriminated union the API route maps to
 * its own `ApiError` types, the same split `services/dev-folder.ts` uses. */
export type InputProcessingResult =
	| { kind: 'ok'; input: ActorInput }
	| { kind: 'not-json' }
	| { kind: 'unparseable-json'; parseError: string }
	| { kind: 'not-object'; actualType: string }
	| { kind: 'invalid'; message: string }
	| { kind: 'invalid-schema'; message: string };

/** The messages the real Apify API answers with, word for word (`@apify-packages/errors`'s
 * `actor.inputNotJson`/`inputNotValidJson`/`inputNotObject`/`inputNotValid`/`invalidInputSchema`) -
 * the whole point of routing validation through the platform's own validator is that the text a
 * developer reads locally is the text they would read against the platform. */
export function describeInputProcessingFailure(result: Exclude<InputProcessingResult, { kind: 'ok' }>): string {
	switch (result.kind) {
		case 'not-json':
			return 'Actor input must have content type "application/json".';
		case 'unparseable-json':
			return `Cannot parse input JSON body: ${result.parseError}`;
		case 'not-object':
			return `The input JSON must be object, got "${result.actualType}" instead.`;
		case 'invalid':
			return `Input is not valid: ${result.message}`;
		case 'invalid-schema':
			return `Input schema is not valid: ${result.message}`;
	}
}

/**
 * Meta-validates an input schema, returning `null` when it is valid or a human-readable defect when it
 * is not. Used at build time (`services/input-schema-location.ts`) so a broken schema is reported where
 * the developer is already looking - the build log - rather than silently at every later run.
 *
 * The meta-schema uses JSON Schema draft 2019-09 features, hence AJV's 2019 build here; the input
 * validator below deliberately uses the plain one, exactly as the platform does for each.
 */
export function describeInputSchemaDefect(schema: unknown): string | null {
	if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
		return 'Input schema must be an object.';
	}
	try {
		// A fresh instance per call: AJV caches every schema it compiles in a Map it never evicts, and
		// this runs once per build, not per request.
		const ajv = new Ajv2019({ strict: false, unicodeRegExp: false });
		// Cloned because `validateInputSchema` normalizes the object it is handed in place.
		validateInputSchema(ajv, structuredClone(schema) as Record<string, unknown>);
		return null;
	} catch (error) {
		return (error as Error).message;
	}
}

/**
 * Applies the schema's defaults to `input` and validates the result, returning the effective input a
 * run should actually be started with. Mirrors the platform's `processInputUsingSchema`: an absent
 * input is not "no input" once a schema exists - it is an empty object the defaults are applied to, so
 * `apify call` with no input at all still gets the schema's defaults in its `INPUT` record, and a
 * required field with no default is still reported missing.
 */
export function processActorInput(input: ActorInput | undefined, schema: InputSchema): InputProcessingResult {
	let parsedInput: unknown = {};
	if (input) {
		if (!isJsonContentType(input.contentType)) return { kind: 'not-json' };
		try {
			parsedInput = JSON.parse(input.body.toString('utf8')) as unknown;
		} catch (error) {
			return { kind: 'unparseable-json', parseError: (error as Error).message };
		}
		// A literal `null` body is the platform's "no input" too, not a type error.
		if (parsedInput === null || parsedInput === undefined) parsedInput = {};
		if (!isPlainObject(parsedInput)) {
			return { kind: 'not-object', actualType: Array.isArray(parsedInput) ? 'array' : typeof parsedInput };
		}
	}

	const withDefaults = mergeDefaultsFromInputSchema(parsedInput as Record<string, unknown>, schema);

	let validator;
	try {
		validator = compileInputSchemaValidator(schema);
	} catch (error) {
		// Only reachable for a schema that passed the build-time meta-validation but still cannot be
		// compiled (or one recorded by an older runtime, before builds validated schemas at all).
		return { kind: 'invalid-schema', message: (error as Error).message };
	}

	// No `proxy` options: proxy-group availability is not emulated here (see this module's doc comment).
	const validationErrors = validateInputUsingValidator(validator, schema, withDefaults, {});
	if (validationErrors.length > 0) {
		// Every message, joined - what the platform returns for an API-origin run (it shortens this to
		// the first message only for the web console, which has a single notification line to show it in).
		return { kind: 'invalid', message: validationErrors.map(({ message }) => message).join(', ') };
	}

	return {
		kind: 'ok',
		input: { body: Buffer.from(JSON.stringify(withDefaults), 'utf8'), contentType: DEFAULT_INPUT_CONTENT_TYPE },
	};
}

const DEFAULT_INPUT_CONTENT_TYPE = 'application/json';

/** `application/json`, with any parameters (`; charset=utf-8`) ignored - the same single media type the
 * platform accepts for an Actor input validated against a schema. */
function isJsonContentType(contentType: string): boolean {
	return contentType.split(';')[0]?.trim().toLowerCase() === DEFAULT_INPUT_CONTENT_TYPE;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merges the schema's default values into `values` and returns a new object - a port of the platform's
 * `mergeDefaultsFromInputSchema`, including its recursion into nested objects and into the items of an
 * array whose `items` sub-schema carries defaults.
 *
 * Exported for direct testing; run-start callers go through `processActorInput`.
 */
export function mergeDefaultsFromInputSchema(
	values: Record<string, unknown>,
	schema: InputSchema,
): Record<string, unknown> {
	const properties = isPlainObject(schema.properties) ? schema.properties : {};
	const defaults: Record<string, unknown> = {};
	for (const [key, fieldSchema] of Object.entries(properties)) {
		defaults[key] = extractDefaults(fieldSchema);
	}

	// Cloned once here so nothing ever assigns a live reference into the schema record itself - a later
	// mutation of the returned input (or of the stored schema) can then never reach the other.
	const clonedDefaults = structuredClone(defaults);
	const target = structuredClone(values);
	assignRecursively(target, clonedDefaults, schema);
	return target;
}

/** The `default` of a field, plus - for an object field with `properties` - the defaults of its nested
 * fields, with the field's own `default` winning over them key by key. */
function extractDefaults(fieldSchema: unknown): unknown {
	if (!isPlainObject(fieldSchema)) return undefined;

	const rootValue = fieldSchema.default;
	const properties = isPlainObject(fieldSchema.properties) ? fieldSchema.properties : undefined;
	if (properties) {
		const nested: Record<string, unknown> = {};
		for (const [key, subSchema] of Object.entries(properties)) {
			nested[key] = extractDefaults(subSchema);
		}
		if (isPlainObject(rootValue)) return deepMerge(nested, rootValue);
		if (Object.values(nested).some((value) => value !== undefined)) return nested;
	}
	return rootValue;
}

/** The defaults for the items of an array field, from its `items` sub-schema. */
function extractArrayItemDefaults(fieldSchema: unknown): unknown {
	if (!isPlainObject(fieldSchema) || !('items' in fieldSchema)) return undefined;
	return extractDefaults(fieldSchema.items);
}

/** Assigns a default only where the current value is `undefined`, recursing into nested objects and
 * into array items. `fillDefinedValues` is set for array items alone, where the platform fills an
 * item's fields even though the item itself is present. */
function assignRecursively(
	target: Record<string, unknown>,
	defaults: Record<string, unknown>,
	schema: InputSchema | undefined,
	fillDefinedValues = false,
): void {
	const schemaProperties = isPlainObject(schema?.properties) ? schema.properties : {};
	const keys = new Set([...Object.keys(defaults), ...Object.keys(schemaProperties)]);

	for (const key of keys) {
		const defaultValue = defaults[key];
		const currentValue = target[key];
		const fieldSchema = schemaProperties[key];

		if (currentValue === undefined) {
			if (defaultValue !== undefined) target[key] = defaultValue;
			continue;
		}

		if (isPlainObject(currentValue)) {
			const nestedDefaults = isPlainObject(defaultValue)
				? defaultValue
				: ((extractDefaults(fieldSchema) as Record<string, unknown> | undefined) ?? {});
			assignRecursively(
				currentValue,
				// Without `fillDefinedValues`, a present nested object keeps exactly the keys it came
				// with - only its own sub-schema's defaults for keys it is missing are considered.
				fillDefinedValues ? nestedDefaults : {},
				fieldSchema as InputSchema | undefined,
			);
			continue;
		}

		if (Array.isArray(currentValue)) {
			const itemDefaults = extractArrayItemDefaults(fieldSchema);
			if (!isPlainObject(itemDefaults)) continue;
			const itemSchema = isPlainObject(fieldSchema) ? fieldSchema.items : undefined;
			for (const item of currentValue) {
				if (!isPlainObject(item)) continue;
				assignRecursively(item, itemDefaults, itemSchema as InputSchema | undefined, true);
			}
		}
	}
}

/** Deep-merges `overrides` onto a copy of `base`, object by object - the one `lodash.merge` behaviour
 * `extractDefaults` needs, without the dependency. Arrays and scalars replace wholesale. */
function deepMerge(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(overrides)) {
		const existing = merged[key];
		merged[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
	}
	return merged;
}

/**
 * Compiled validators, keyed by the schema's serialization - a run start would otherwise recompile the
 * same schema on every single call. Bounded and oldest-first evicted, the same reason the platform caps
 * its own LRU: a long-lived runtime must not grow a map per schema it has ever seen.
 */
const validatorCache = new Map<string, InputValidator>();
const VALIDATOR_CACHE_MAX_ENTRIES = 100;

function compileInputSchemaValidator(schema: InputSchema): InputValidator {
	const cacheKey = JSON.stringify(schema);
	const cached = validatorCache.get(cacheKey);
	if (cached) return cached;

	const validator = new Ajv({ strict: false, unicodeRegExp: false }).compile(prepareSchemaForValidation(schema));

	if (validatorCache.size >= VALIDATOR_CACHE_MAX_ENTRIES) {
		const oldest = validatorCache.keys().next();
		if (!oldest.done) validatorCache.delete(oldest.value);
	}
	validatorCache.set(cacheKey, validator);
	return validator;
}

/**
 * The platform's `getAjvValidator` preparation, ported: a required field that has a default is treated
 * as optional (there is always a value for it by the time validation runs), a required array must hold
 * at least one item, and `$schema` is dropped because AJV would otherwise try to fetch the Apify
 * meta-schema it names and fail to compile the schema at all.
 */
function prepareSchemaForValidation(schema: InputSchema): Record<string, unknown> {
	const copy = structuredClone(schema) as Record<string, unknown>;
	const required: string[] = [];
	const originalRequired = Array.isArray(schema.required) ? schema.required : [];
	const properties = isPlainObject(copy.properties) ? copy.properties : {};

	for (const [key, fieldSchema] of Object.entries(properties)) {
		if (!originalRequired.includes(key)) continue;
		if (isPlainObject(fieldSchema) && fieldSchema.default !== undefined) continue;
		required.push(key);
		if (isPlainObject(fieldSchema) && fieldSchema.type === 'array') {
			const minItems = typeof fieldSchema.minItems === 'number' ? fieldSchema.minItems : 0;
			fieldSchema.minItems = Math.max(1, minItems);
		}
	}

	copy.required = required;
	delete copy.$schema;
	return copy;
}

/** Test-only: a validator compiled against one test's schema must never be reused by the next. */
export function resetInputSchemaValidatorCacheForTests(): void {
	validatorCache.clear();
}
