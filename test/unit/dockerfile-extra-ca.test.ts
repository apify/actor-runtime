import { describe, expect, it } from 'vitest';

import { addExtraCaToDockerfile } from '../../src/services/dockerfile-extra-ca.js';

const COPY = 'COPY actor-runtime-extra-ca.pem /actor-runtime-extra-ca.pem';
const ENV = 'ENV NODE_EXTRA_CA_CERTS=/actor-runtime-extra-ca.pem';

describe('addExtraCaToDockerfile (a build trusts the extra CA bundle in every stage)', () => {
	it('adds the bundle and NODE_EXTRA_CA_CERTS right after the FROM line', () => {
		const result = addExtraCaToDockerfile('FROM node:20\nCOPY . .\nRUN npm install');
		expect(result.dockerfile).toBe(`FROM node:20\n${COPY}\n${ENV}\nCOPY . .\nRUN npm install`);
		expect(result.stages).toBe(1);
	});

	it('does it in every stage of a multi-stage build', () => {
		const result = addExtraCaToDockerfile(
			'FROM node:20 AS build\nRUN npm ci\nFROM node:20\nCOPY --from=build /a /a',
		);
		expect(result.stages).toBe(2);
		expect(result.dockerfile.split(COPY).length - 1).toBe(2);
	});

	it('keeps ARG lines before the first FROM ahead of it, and is case-insensitive', () => {
		const result = addExtraCaToDockerfile('ARG BASE=node:20\nfrom ${BASE}\nRUN true');
		expect(result.dockerfile).toBe(`ARG BASE=node:20\nfrom \${BASE}\n${COPY}\n${ENV}\nRUN true`);
	});

	it('places the instructions after a FROM that continues over several lines', () => {
		const result = addExtraCaToDockerfile('FROM \\\n  node:20 \\\n  AS base\nRUN true');
		expect(result.dockerfile).toBe(`FROM \\\n  node:20 \\\n  AS base\n${COPY}\n${ENV}\nRUN true`);
	});

	it('reports no stages for a file without FROM', () => {
		expect(addExtraCaToDockerfile('# empty').stages).toBe(0);
	});
});
