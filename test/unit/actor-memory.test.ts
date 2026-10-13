import { describe, expect, it } from 'vitest';

import {
	resolveActorMemorySettings,
	resolveRunMemory,
	type RunMemoryContext,
} from '../../src/services/actor-memory.js';
import type { SourceFile } from '../../src/storage/entities.js';

function actorJson(spec: Record<string, unknown>): SourceFile[] {
	return [{ name: '.actor/actor.json', format: 'TEXT', content: JSON.stringify(spec) }];
}

function context(overrides: Partial<RunMemoryContext> = {}): RunMemoryContext {
	return {
		requestedMemoryMbytes: undefined,
		fallbackMemoryMbytes: 1024,
		runOptions: { build: 'latest', timeoutSecs: 300, diskMbytes: 2048 },
		input: undefined,
		...overrides,
	};
}

function jsonInput(value: unknown): RunMemoryContext['input'] {
	return { body: Buffer.from(JSON.stringify(value)), contentType: 'application/json' };
}

describe('resolveActorMemorySettings', () => {
	it('reads the three memory fields, and nothing when none is declared', () => {
		expect(
			resolveActorMemorySettings(
				actorJson({ defaultMemoryMbytes: '{{input.n}} * 512', minMemoryMbytes: 512, maxMemoryMbytes: 8192 }),
			),
		).toEqual({
			outcome: 'resolved',
			settings: { defaultMemoryMbytes: '{{input.n}} * 512', minMemoryMbytes: 512, maxMemoryMbytes: 8192 },
		});
		expect(resolveActorMemorySettings(actorJson({ name: 'x' }))).toEqual({
			outcome: 'resolved',
			settings: undefined,
		});
		expect(resolveActorMemorySettings([])).toEqual({ outcome: 'resolved', settings: undefined });
	});

	it.each([
		[{ minMemoryMbytes: 64 }, 'minMemoryMbytes'],
		[{ maxMemoryMbytes: '4096' }, 'maxMemoryMbytes'],
		[{ defaultMemoryMbytes: 1024.5 }, 'defaultMemoryMbytes'],
	])('fails on an out-of-schema value: %j', (spec, field) => {
		const result = resolveActorMemorySettings(actorJson(spec));
		expect(result.outcome).toBe('failure');
		if (result.outcome === 'failure') expect(result.message).toContain(`"${field}"`);
	});
});

describe('resolveRunMemory', () => {
	it('uses the fallback when neither the caller nor the Actor sets a memory', async () => {
		expect(await resolveRunMemory(undefined, context())).toEqual({ memoryMbytes: 1024, logLines: [] });
	});

	it('evaluates defaultMemoryMbytes against the input and run options, rounded to a power of two', async () => {
		const settings = { defaultMemoryMbytes: "get(input, 'urls.length', 1) * 1000 + {{runOptions.timeoutSecs}}" };
		const result = await resolveRunMemory(settings, context({ input: jsonInput({ urls: ['a', 'b', 'c', 'd'] }) }));
		expect(result.memoryMbytes).toBe(4096);
		expect(await resolveRunMemory({ defaultMemoryMbytes: 2048 }, context())).toEqual({
			memoryMbytes: 2048,
			logLines: [],
		});
	});

	it("lets the caller's memory win over defaultMemoryMbytes", async () => {
		const result = await resolveRunMemory({ defaultMemoryMbytes: 4096 }, context({ requestedMemoryMbytes: 256 }));
		expect(result.memoryMbytes).toBe(256);
	});

	it('falls back, with a warning, when the expression cannot be evaluated', async () => {
		const result = await resolveRunMemory({ defaultMemoryMbytes: '{{nope}} * 2' }, context());
		expect(result.memoryMbytes).toBe(1024);
		expect(result.logLines).toHaveLength(1);
		expect(result.logLines[0]).toContain('could not evaluate "defaultMemoryMbytes"');
	});

	it('clamps to minMemoryMbytes / maxMemoryMbytes, including an explicit request', async () => {
		const bounds = { minMemoryMbytes: 4096, maxMemoryMbytes: 8192 };
		expect(await resolveRunMemory(bounds, context())).toEqual({
			memoryMbytes: 4096,
			logLines: ['Memory of 1024 MB adjusted to 4096 MB by "minMemoryMbytes" in .actor/actor.json.'],
		});
		expect((await resolveRunMemory(bounds, context({ requestedMemoryMbytes: 16384 }))).memoryMbytes).toBe(8192);
		expect((await resolveRunMemory({ ...bounds, defaultMemoryMbytes: 128 }, context())).memoryMbytes).toBe(4096);
	});
});
