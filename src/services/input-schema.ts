/**
 * Input validation and defaults at run start; `services/input-schema-location.ts` is the build-time
 * half that finds the schema in the pushed source.
 *
 * Validation goes through the platform's own `@apify/input_schema`, driven by the same AJV
 * configuration the platform's API uses, so a developer reads locally the very message the real API
 * would answer with rather than an approximation of it.
 */
import ajvPackage from 'ajv';
import ajv2019Package from 'ajv/dist/2019.js';
import { validateInputSchema, validateInputUsingValidator } from '@apify/input_schema';

import type { InputSchema } from '../storage/entities.js';

// AJV ships as CommonJS, so under this package's ESM resolution its class arrives as the module's
// `default`. `2019` is the same library with draft-2019-09 support, which the Apify input-schema
// meta-schema requires and the plain build lacks.
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

/** The real Apify API's messages, word for word (`@apify-packages/errors`'s `actor.inputNotJson` and
 * its neighbours). */
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
 * `null` for a valid input schema, the defect otherwise. Runs at build time, so a broken schema is
 * reported where the developer is already looking rather than silently at every later run.
 */
export function describeInputSchemaDefect(schema: unknown): string | null {
	if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
		return 'Input schema must be an object.';
	}
	try {
		// A fresh instance per call: AJV never evicts its internal compiled-schema map, and this runs
		// once per build, not per request.
		const ajv = new Ajv2019({ strict: false, unicodeRegExp: false });
		// `validateInputSchema` normalizes in place, so it must not get the stored schema itself.
		validateInputSchema(ajv, structuredClone(schema) as Record<string, unknown>);
		return null;
	} catch (error) {
		return (error as Error).message;
	}
}

/**
 * The effective input a run should start with. Mirrors the platform's `processInputUsingSchema`: once
 * a schema exists, an absent input is an empty object the defaults are applied to, not "no input" - so
 * a call with no input still gets the defaults, and a required field with no default is still missing.
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
		// Reachable only for a schema recorded before builds validated them, or one that meta-validates
		// yet still will not compile.
		return { kind: 'invalid-schema', message: (error as Error).message };
	}

	// No `proxy` options: this runtime emulates no proxy groups (`unsupported.md`), so any
	// `apifyProxyGroups` selection is accepted, while the rest of a proxy field is still checked.
	const validationErrors = validateInputUsingValidator(validator, schema, withDefaults, {});
	if (validationErrors.length > 0) {
		// Joined, as the platform answers an API-origin run; it shortens this to the first message only
		// for the web console, which has one notification line to show it in.
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
 * A port of the platform's `mergeDefaultsFromInputSchema`, recursion into nested objects and array
 * items included. Exported for direct testing; run-start callers go through `processActorInput`.
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

	// Cloned so no reference into the stored schema is ever assigned into the returned input, where a
	// later mutation of either would reach the other.
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

/** `fillDefinedValues` is set for array items alone, where the platform fills an item's fields even
 * though the item itself is present. */
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
				// A present nested object otherwise keeps exactly the keys it came with.
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

/** The one `lodash.merge` behaviour `extractDefaults` needs, without the dependency: objects merge
 * key by key, arrays and scalars replace wholesale. */
function deepMerge(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(overrides)) {
		const existing = merged[key];
		merged[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
	}
	return merged;
}

/**
 * Compiled validators, keyed by the schema's serialization: every run start would otherwise recompile
 * the same schema. Bounded and oldest-first evicted, so a long-lived runtime does not keep an entry
 * per schema it has ever seen.
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
 * The platform's `getAjvValidator` preparation, ported: a required field with a default is optional
 * (there is always a value for it by then), a required array must hold at least one item, and
 * `$schema` is dropped - AJV would otherwise try to fetch the Apify meta-schema it names and fail to
 * compile at all.
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
