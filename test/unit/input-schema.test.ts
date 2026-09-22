import { afterEach, describe, expect, it } from 'vitest';

import {
	describeInputProcessingFailure,
	describeInputSchemaDefect,
	mergeDefaultsFromInputSchema,
	processActorInput,
	resetInputSchemaValidatorCacheForTests,
} from '../../src/services/input-schema.js';
import type { InputSchema } from '../../src/storage/entities.js';

const SAMPLE_SCHEMA: InputSchema = {
	title: 'Sample actor input',
	type: 'object',
	schemaVersion: 1,
	properties: {
		startUrl: {
			title: 'Start URL',
			type: 'string',
			editor: 'textfield',
			description: 'The page the crawler starts from.',
			default: 'https://crawlee.dev/',
		},
		maxPages: {
			title: 'Max pages',
			type: 'integer',
			description: 'The maximum number of pages to crawl.',
			default: 2,
			minimum: 1,
		},
		label: { title: 'Label', type: 'string', editor: 'textfield', description: 'A free-form label.' },
	},
	required: ['startUrl'],
};

function jsonInput(value: unknown): { body: Buffer; contentType: string } {
	return { body: Buffer.from(JSON.stringify(value), 'utf8'), contentType: 'application/json' };
}

function effectiveInput(result: ReturnType<typeof processActorInput>): Record<string, unknown> {
	if (result.kind !== 'ok') throw new Error(`expected an accepted input, got ${result.kind}`);
	expect(result.input.contentType).toBe('application/json');
	return JSON.parse(result.input.body.toString('utf8')) as Record<string, unknown>;
}

afterEach(() => {
	resetInputSchemaValidatorCacheForTests();
});

describe('processActorInput - defaults', () => {
	it('fills every missing field from the schema and leaves provided ones alone', () => {
		expect(effectiveInput(processActorInput(jsonInput({ maxPages: 7 }), SAMPLE_SCHEMA))).toEqual({
			maxPages: 7,
			startUrl: 'https://crawlee.dev/',
		});
	});

	it('turns "no input at all" into the schema\'s defaults, the way the platform does', () => {
		expect(effectiveInput(processActorInput(undefined, SAMPLE_SCHEMA))).toEqual({
			startUrl: 'https://crawlee.dev/',
			maxPages: 2,
		});
	});

	it('treats a literal null body as no input, not as a type error', () => {
		const result = processActorInput(
			{ body: Buffer.from('null', 'utf8'), contentType: 'application/json' },
			SAMPLE_SCHEMA,
		);
		expect(effectiveInput(result)).toEqual({ startUrl: 'https://crawlee.dev/', maxPages: 2 });
	});

	it("keeps a provided value even when it equals the type's zero value", () => {
		const schema: InputSchema = {
			title: 'Flags',
			type: 'object',
			schemaVersion: 1,
			properties: {
				enabled: { title: 'Enabled', type: 'boolean', description: 'A flag.', default: true },
				count: { title: 'Count', type: 'integer', description: 'A count.', default: 5 },
			},
		};
		expect(effectiveInput(processActorInput(jsonInput({ enabled: false, count: 0 }), schema))).toEqual({
			enabled: false,
			count: 0,
		});
	});

	it('accepts application/json with parameters, such as a charset', () => {
		const result = processActorInput(
			{ body: Buffer.from('{"maxPages":3}', 'utf8'), contentType: 'application/json; charset=utf-8' },
			SAMPLE_SCHEMA,
		);
		expect(effectiveInput(result)).toMatchObject({ maxPages: 3 });
	});
});

describe('mergeDefaultsFromInputSchema', () => {
	const NESTED_SCHEMA: InputSchema = {
		title: 'Nested',
		type: 'object',
		schemaVersion: 1,
		properties: {
			config: {
				title: 'Config',
				type: 'object',
				editor: 'json',
				description: 'A nested object.',
				properties: {
					retries: { title: 'Retries', type: 'integer', description: 'How many.', default: 3 },
					verbose: { title: 'Verbose', type: 'boolean', description: 'Chatty?', default: false },
				},
			},
			items: {
				title: 'Items',
				type: 'array',
				editor: 'json',
				description: 'A list of objects.',
				items: { type: 'object', properties: { keep: { type: 'boolean', default: true } } },
			},
		},
	};

	it("builds a nested object out of its fields' defaults when the whole object is missing", () => {
		expect(mergeDefaultsFromInputSchema({}, NESTED_SCHEMA)).toEqual({
			config: { retries: 3, verbose: false },
		});
	});

	it('leaves a provided nested object exactly as it came, adding no keys to it', () => {
		expect(mergeDefaultsFromInputSchema({ config: { retries: 9 } }, NESTED_SCHEMA)).toEqual({
			config: { retries: 9 },
		});
	});

	it('fills defaults into every item of a provided array, without overwriting what the item has', () => {
		expect(mergeDefaultsFromInputSchema({ items: [{}, { keep: false }] }, NESTED_SCHEMA)).toEqual({
			config: { retries: 3, verbose: false },
			items: [{ keep: true }, { keep: false }],
		});
	});

	it('never hands out a reference into the schema, so a later edit of the input cannot corrupt it', () => {
		const merged = mergeDefaultsFromInputSchema({}, NESTED_SCHEMA) as { config: Record<string, unknown> };
		merged.config.retries = 999;
		expect(mergeDefaultsFromInputSchema({}, NESTED_SCHEMA)).toEqual({ config: { retries: 3, verbose: false } });
	});

	it("applies the field's own default over the defaults of its nested fields", () => {
		const schema: InputSchema = {
			title: 'Merged',
			type: 'object',
			schemaVersion: 1,
			properties: {
				config: {
					title: 'Config',
					type: 'object',
					editor: 'json',
					description: 'A nested object with its own default.',
					default: { retries: 10 },
					properties: {
						retries: { title: 'Retries', type: 'integer', description: 'How many.', default: 3 },
						verbose: { title: 'Verbose', type: 'boolean', description: 'Chatty?', default: false },
					},
				},
			},
		};
		expect(mergeDefaultsFromInputSchema({}, schema)).toEqual({ config: { retries: 10, verbose: false } });
	});
});

describe('processActorInput - validation', () => {
	it("reports the platform's message for a value below a minimum", () => {
		const result = processActorInput(jsonInput({ maxPages: 0 }), SAMPLE_SCHEMA);
		expect(result).toEqual({ kind: 'invalid', message: 'Field input.maxPages must be >= 1' });
		expect(describeInputProcessingFailure(result as never)).toBe(
			'Input is not valid: Field input.maxPages must be >= 1',
		);
	});

	it("reports the platform's message for a value of the wrong type", () => {
		expect(processActorInput(jsonInput({ label: 5 }), SAMPLE_SCHEMA)).toEqual({
			kind: 'invalid',
			message: 'Field input.label must be string',
		});
	});

	it('treats a required field that has a default as satisfied by that default', () => {
		// `startUrl` is required and has a default - the platform relaxes exactly this case, since there
		// is always a value for such a field by the time validation runs.
		expect(effectiveInput(processActorInput(jsonInput({}), SAMPLE_SCHEMA))).toMatchObject({
			startUrl: 'https://crawlee.dev/',
		});
	});

	it('still reports a required field that has no default, even for a run started with no input', () => {
		const schema: InputSchema = {
			...SAMPLE_SCHEMA,
			required: ['startUrl', 'label'],
		};
		expect(processActorInput(undefined, schema)).toEqual({
			kind: 'invalid',
			message: 'Field input.label is required',
		});
	});

	it('joins every validation error, the way the API-origin platform response does', () => {
		// Two errors of different provenance: the first from AJV (which, configured as the platform
		// configures it, reports one at a time), the second from the schema-aware checks that run after it.
		const schema: InputSchema = {
			title: 'Two problems',
			type: 'object',
			schemaVersion: 1,
			properties: {
				a: { title: 'A', type: 'integer', description: 'A number.', minimum: 10 },
				startUrls: {
					title: 'Start URLs',
					type: 'array',
					editor: 'requestListSources',
					description: 'Where to start.',
				},
			},
		};
		const result = processActorInput(jsonInput({ a: 1, startUrls: [{ url: 'not a url' }] }), schema);
		expect(result.kind).toBe('invalid');
		if (result.kind !== 'invalid') return;
		expect(result.message).toContain('Field input.a must be >= 10');
		expect(result.message).toContain('input.startUrls');
		expect(result.message).toContain(', ');
	});

	it('requires at least one item in a required array field', () => {
		const schema: InputSchema = {
			title: 'Sources',
			type: 'object',
			schemaVersion: 1,
			properties: {
				startUrls: {
					title: 'Start URLs',
					type: 'array',
					editor: 'requestListSources',
					description: 'Where to start.',
				},
			},
			required: ['startUrls'],
		};
		expect(processActorInput(jsonInput({ startUrls: [] }), schema)).toMatchObject({ kind: 'invalid' });
		expect(
			effectiveInput(processActorInput(jsonInput({ startUrls: [{ url: 'https://crawlee.dev/' }] }), schema)),
		).toEqual({ startUrls: [{ url: 'https://crawlee.dev/' }] });
	});

	it('runs the checks AJV alone cannot express, such as requestListSources entries', () => {
		const schema: InputSchema = {
			title: 'Sources',
			type: 'object',
			schemaVersion: 1,
			properties: {
				startUrls: {
					title: 'Start URLs',
					type: 'array',
					editor: 'requestListSources',
					description: 'Where to start.',
				},
			},
		};
		expect(processActorInput(jsonInput({ startUrls: [{ url: 'not a url' }] }), schema)).toMatchObject({
			kind: 'invalid',
		});
	});

	it('accepts any apifyProxyGroups selection, since proxy groups are not emulated locally', () => {
		const schema: InputSchema = {
			title: 'Proxy',
			type: 'object',
			schemaVersion: 1,
			properties: {
				proxyConfiguration: {
					title: 'Proxy configuration',
					type: 'object',
					editor: 'proxy',
					description: 'Proxy settings.',
					default: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
				},
			},
		};
		expect(effectiveInput(processActorInput(undefined, schema))).toEqual({
			proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
		});
		// Shape checks still apply: a custom proxy URL that is not one is still rejected.
		expect(
			processActorInput(
				jsonInput({ proxyConfiguration: { useApifyProxy: false, proxyUrls: ['nonsense'] } }),
				schema,
			),
		).toMatchObject({ kind: 'invalid' });
	});

	it('compiles a schema carrying the $schema field templates ship with', () => {
		const schema: InputSchema = { ...SAMPLE_SCHEMA, $schema: 'https://apify.com/schemas/v1/input.ide.json' };
		expect(effectiveInput(processActorInput(jsonInput({ maxPages: 4 }), schema))).toMatchObject({ maxPages: 4 });
	});
});

describe('processActorInput - malformed requests', () => {
	it('rejects a body that is not sent as JSON', () => {
		const result = processActorInput({ body: Buffer.from('{}', 'utf8'), contentType: 'text/plain' }, SAMPLE_SCHEMA);
		expect(result).toEqual({ kind: 'not-json' });
		expect(describeInputProcessingFailure(result as never)).toBe(
			'Actor input must have content type "application/json".',
		);
	});

	it('rejects a body that is not parseable JSON', () => {
		const result = processActorInput(
			{ body: Buffer.from('{oops', 'utf8'), contentType: 'application/json' },
			SAMPLE_SCHEMA,
		);
		expect(result.kind).toBe('unparseable-json');
		expect(describeInputProcessingFailure(result as never)).toContain('Cannot parse input JSON body:');
	});

	it('rejects a JSON body that is not an object, naming what it got instead', () => {
		const array = processActorInput(jsonInput([1, 2]), SAMPLE_SCHEMA);
		expect(array).toEqual({ kind: 'not-object', actualType: 'array' });
		expect(describeInputProcessingFailure(array as never)).toBe(
			'The input JSON must be object, got "array" instead.',
		);

		expect(processActorInput(jsonInput('a string'), SAMPLE_SCHEMA)).toEqual({
			kind: 'not-object',
			actualType: 'string',
		});
	});

	it('reports a schema that cannot be compiled at all, rather than throwing', () => {
		const broken: InputSchema = { title: 'Broken', type: 'object', properties: { a: { type: 'not-a-type' } } };
		const result = processActorInput(jsonInput({}), broken);
		expect(result.kind).toBe('invalid-schema');
		expect(describeInputProcessingFailure(result as never)).toContain('Input schema is not valid:');
	});
});

describe('describeInputSchemaDefect', () => {
	it('accepts a valid schema', () => {
		expect(describeInputSchemaDefect(SAMPLE_SCHEMA)).toBeNull();
	});

	it('names the defect of an invalid one', () => {
		const defect = describeInputSchemaDefect({
			title: 'No description',
			type: 'object',
			schemaVersion: 1,
			properties: { a: { title: 'A', type: 'string', editor: 'textfield' } },
		});
		expect(defect).toContain('description');
	});

	it('rejects a required field that no property defines', () => {
		const defect = describeInputSchemaDefect({
			title: 'Ghost',
			type: 'object',
			schemaVersion: 1,
			properties: {},
			required: ['ghost'],
		});
		expect(defect).toContain('ghost');
	});

	it('rejects anything that is not an object', () => {
		expect(describeInputSchemaDefect(['a'])).toBe('Input schema must be an object.');
		expect(describeInputSchemaDefect('a schema')).toBe('Input schema must be an object.');
		expect(describeInputSchemaDefect(null)).toBe('Input schema must be an object.');
	});
});
