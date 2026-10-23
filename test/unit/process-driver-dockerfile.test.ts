import { describe, expect, it } from 'vitest';

import {
	expandVariables,
	parseDockerfile,
	parseExecForm,
	parseKeyValues,
} from '../../src/driver/process/dockerfile.js';
import { parseImageRef } from '../../src/driver/process/registry.js';

describe('parseDockerfile', () => {
	it('joins continuations, skips comments and reads flags', () => {
		const result = parseDockerfile('# c\nFROM node:20 AS build\nRUN a \\\n  && b\nCOPY --from=build /x /y\n');
		expect(result.map((i) => i.keyword)).toEqual(['FROM', 'RUN', 'COPY']);
		expect(result[1]!.args).toBe('a  && b');
		expect(result[2]).toMatchObject({ flags: { from: 'build' }, args: '/x /y' });
	});
});

describe('Dockerfile values', () => {
	it('parses exec form only for JSON arrays of strings', () => {
		expect(parseExecForm('["node","main.js"]')).toEqual(['node', 'main.js']);
		expect(parseExecForm('node main.js')).toBeUndefined();
	});
	it('expands variables with defaults', () => {
		expect(expandVariables('$A-${B}-${C:-d}', { A: '1', B: '2' })).toBe('1-2-d');
	});
	it('reads both ENV forms', () => {
		expect(parseKeyValues('A=1 B="x y"')).toEqual([
			['A', '1'],
			['B', 'x y'],
		]);
		expect(parseKeyValues('A some value')).toEqual([['A', 'some value']]);
	});
});

describe('parseImageRef', () => {
	it('defaults to Docker Hub library images', () => {
		expect(parseImageRef('node:20')).toEqual({
			registry: 'registry-1.docker.io',
			repository: 'library/node',
			reference: '20',
		});
		expect(parseImageRef('apify/actor-node')).toMatchObject({
			repository: 'apify/actor-node',
			reference: 'latest',
		});
	});
	it('keeps an explicit registry and digest', () => {
		expect(parseImageRef('ghcr.io/o/r@sha256:ab')).toEqual({
			registry: 'ghcr.io',
			repository: 'o/r',
			reference: 'sha256:ab',
		});
	});
});
