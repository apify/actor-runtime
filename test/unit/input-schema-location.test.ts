import { describe, expect, it } from 'vitest';

import { resolveInputSchemaLocation } from '../../src/services/input-schema-location.js';
import type { SourceFile } from '../../src/storage/entities.js';

/** A minimal but genuinely valid input schema - every field the Apify meta-schema demands is present,
 * so a test that is not about schema validity never trips over it. */
function validSchema(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		title: 'Sample input',
		type: 'object',
		schemaVersion: 1,
		properties: {
			maxPages: { title: 'Max pages', type: 'integer', description: 'How many pages.', default: 2 },
		},
		...extra,
	};
}

function text(name: string, content: string): SourceFile {
	return { name, format: 'TEXT', content };
}

function json(name: string, value: unknown): SourceFile {
	return text(name, JSON.stringify(value));
}

describe('resolveInputSchemaLocation', () => {
	it('takes an inline schema object from the "input" field of .actor/actor.json', () => {
		const resolution = resolveInputSchemaLocation([
			json('.actor/actor.json', { actorSpecification: 1, name: 'a', input: validSchema() }),
			json('.actor/input_schema.json', validSchema({ title: 'The file, which must lose' })),
		]);

		expect(resolution.outcome).toBe('resolved');
		if (resolution.outcome !== 'resolved') return;
		expect(resolution.schema.title).toBe('Sample input');
		expect(resolution.source).toContain('"input" field');
		expect(resolution.logLines.join('')).toContain('Using the input schema from');
	});

	it('follows a path in the "input" field, resolved relative to .actor/', () => {
		const resolution = resolveInputSchemaLocation([
			json('.actor/actor.json', { actorSpecification: 1, input: './schemas/custom.json' }),
			json('.actor/schemas/custom.json', validSchema({ title: 'From the named file' })),
		]);

		expect(resolution.outcome).toBe('resolved');
		if (resolution.outcome !== 'resolved') return;
		expect(resolution.schema.title).toBe('From the named file');
		expect(resolution.source).toContain('.actor/schemas/custom.json');
	});

	it('falls back to the default locations, with a warning, when the named file is not in the pushed source', () => {
		const resolution = resolveInputSchemaLocation([
			json('.actor/actor.json', { actorSpecification: 1, input: './missing.json' }),
			json('.actor/input_schema.json', validSchema({ title: 'The fallback' })),
		]);

		expect(resolution.outcome).toBe('resolved');
		if (resolution.outcome !== 'resolved') return;
		expect(resolution.schema.title).toBe('The fallback');
		expect(resolution.logLines.join('')).toContain('is not in the pushed source');
	});

	it('treats an empty "input" field as "not found", falling through with a warning', () => {
		const resolution = resolveInputSchemaLocation([
			json('.actor/actor.json', { actorSpecification: 1, input: '' }),
			json('input_schema.json', validSchema({ title: 'Root fallback' })),
		]);

		expect(resolution.outcome).toBe('resolved');
		if (resolution.outcome !== 'resolved') return;
		expect(resolution.schema.title).toBe('Root fallback');
		expect(resolution.logLines.join('')).toContain('falling back to the default locations');
	});

	it('rejects an "input" path that escapes the Actor root, absolute or relative', () => {
		for (const field of ['/etc/passwd', '../../outside.json']) {
			const resolution = resolveInputSchemaLocation([
				json('.actor/actor.json', { actorSpecification: 1, input: field }),
			]);
			expect(resolution.outcome).toBe('failure');
			if (resolution.outcome !== 'failure') return;
			expect(resolution.reason).toBe('escapes-actor-root');
			expect(resolution.message).toContain('points outside the Actor root directory');
		}
	});

	it('rejects an "input" field that is neither a string nor an object', () => {
		const resolution = resolveInputSchemaLocation([
			json('.actor/actor.json', { actorSpecification: 1, input: 42 }),
		]);

		expect(resolution.outcome).toBe('failure');
		if (resolution.outcome !== 'failure') return;
		expect(resolution.reason).toBe('invalid-input-field');
		expect(resolution.message).toBe('.actor/actor.json has invalid format: "input" must be a string or an object.');
	});

	it('prefers .actor/INPUT_SCHEMA.json over the Actor root one, matching case-insensitively', () => {
		const resolution = resolveInputSchemaLocation([
			json('INPUT_SCHEMA.json', validSchema({ title: 'Root' })),
			json('.actor/INPUT_SCHEMA.json', validSchema({ title: 'Actor dir' })),
		]);

		expect(resolution.outcome).toBe('resolved');
		if (resolution.outcome !== 'resolved') return;
		expect(resolution.schema.title).toBe('Actor dir');
		expect(resolution.source).toContain('.actor/INPUT_SCHEMA.json');
	});

	it('reads a BASE64-encoded schema file the same as a TEXT one', () => {
		const resolution = resolveInputSchemaLocation([
			{
				name: '.actor/input_schema.json',
				format: 'BASE64',
				content: Buffer.from(JSON.stringify(validSchema({ title: 'Encoded' })), 'utf8').toString('base64'),
			},
		]);

		expect(resolution.outcome).toBe('resolved');
		if (resolution.outcome !== 'resolved') return;
		expect(resolution.schema.title).toBe('Encoded');
	});

	it('reports no schema at all - not a failure - when the source declares none', () => {
		const resolution = resolveInputSchemaLocation([text('main.js', 'console.log(1)')]);
		expect(resolution.outcome).toBe('none');
	});

	it('fails on a schema file that cannot be parsed', () => {
		const resolution = resolveInputSchemaLocation([text('.actor/input_schema.json', '{ "title": ')]);

		expect(resolution.outcome).toBe('failure');
		if (resolution.outcome !== 'failure') return;
		expect(resolution.reason).toBe('unparseable-input-schema');
		expect(resolution.message).toContain('Could not parse the input schema ".actor/input_schema.json"');
	});

	it("fails on a schema the platform's own meta-schema rejects, naming where it came from", () => {
		const resolution = resolveInputSchemaLocation([
			json('.actor/input_schema.json', {
				title: 'Missing a field description',
				type: 'object',
				schemaVersion: 1,
				properties: { maxPages: { title: 'Max pages', type: 'integer' } },
			}),
		]);

		expect(resolution.outcome).toBe('failure');
		if (resolution.outcome !== 'failure') return;
		expect(resolution.reason).toBe('invalid-input-schema');
		expect(resolution.message).toContain('.actor/input_schema.json');
		expect(resolution.message).toContain('is not valid');
	});

	it('rejects a schema that is not an object at all', () => {
		const resolution = resolveInputSchemaLocation([json('.actor/input_schema.json', ['not', 'a', 'schema'])]);

		expect(resolution.outcome).toBe('failure');
		if (resolution.outcome !== 'failure') return;
		expect(resolution.reason).toBe('invalid-input-schema');
	});

	it('leaves an unparseable .actor/actor.json to the Dockerfile resolver, falling through to the default locations', () => {
		// `services/dockerfile-location.ts` runs first on the same file and already fails that build with
		// its own message; this must not add a second, differently-worded report of the same defect.
		const resolution = resolveInputSchemaLocation([
			text('.actor/actor.json', '{ not json at all'),
			json('.actor/input_schema.json', validSchema({ title: 'Still found' })),
		]);

		expect(resolution.outcome).toBe('resolved');
		if (resolution.outcome !== 'resolved') return;
		expect(resolution.schema.title).toBe('Still found');
	});

	it('parses .actor/actor.json as JSON5, like the Dockerfile lookup already does', () => {
		const resolution = resolveInputSchemaLocation([
			text('.actor/actor.json', "{ actorSpecification: 1, input: './input_schema.json' /* a comment */ }"),
			json('.actor/input_schema.json', validSchema({ title: 'Via JSON5' })),
		]);

		expect(resolution.outcome).toBe('resolved');
		if (resolution.outcome !== 'resolved') return;
		expect(resolution.schema.title).toBe('Via JSON5');
	});

	it('accepts the $schema field real Actor templates carry', () => {
		const resolution = resolveInputSchemaLocation([
			json(
				'.actor/input_schema.json',
				validSchema({ $schema: 'https://apify.com/schemas/v1/input.ide.json', title: 'Templated' }),
			),
		]);

		expect(resolution.outcome).toBe('resolved');
	});
});
