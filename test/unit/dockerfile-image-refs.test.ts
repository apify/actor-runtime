import { describe, expect, it } from 'vitest';

import { qualifyDockerfileImageReferences, qualifyImageReference } from '../../src/services/dockerfile-image-refs.js';

const noStages = new Set<string>();

describe('qualifyImageReference (Docker Hub is where a short image name lives, on every engine)', () => {
	it('prefixes a namespaced short name with docker.io, keeping tag or digest', () => {
		expect(qualifyImageReference('apify/actor-node:20', noStages)).toBe('docker.io/apify/actor-node:20');
		expect(qualifyImageReference('apify/actor-python-playwright:3.14-1.61.0', noStages)).toBe(
			'docker.io/apify/actor-python-playwright:3.14-1.61.0',
		);
		expect(qualifyImageReference('apify/actor-node@sha256:abc', noStages)).toBe(
			'docker.io/apify/actor-node@sha256:abc',
		);
	});

	it('puts a single-segment name under library/, with a tag colon never mistaken for a registry port', () => {
		expect(qualifyImageReference('python:3.11-slim', noStages)).toBe('docker.io/library/python:3.11-slim');
		expect(qualifyImageReference('alpine', noStages)).toBe('docker.io/library/alpine');
		expect(qualifyImageReference('node@sha256:abc', noStages)).toBe('docker.io/library/node@sha256:abc');
	});

	it('leaves an already-qualified reference alone: a dotted host, a host with a port, or localhost', () => {
		expect(qualifyImageReference('docker.io/apify/actor-node:20', noStages)).toBeUndefined();
		expect(qualifyImageReference('ghcr.io/org/image:1', noStages)).toBeUndefined();
		expect(qualifyImageReference('registry:5000/image:1', noStages)).toBeUndefined();
		expect(qualifyImageReference('localhost/actor-runtime:latest', noStages)).toBeUndefined();
	});

	it('leaves scratch, a variable, and a build-stage reference alone', () => {
		expect(qualifyImageReference('scratch', noStages)).toBeUndefined();
		expect(qualifyImageReference('SCRATCH', noStages)).toBeUndefined();
		expect(qualifyImageReference('${BASE_IMAGE}', noStages)).toBeUndefined();
		expect(qualifyImageReference('$BASE', noStages)).toBeUndefined();
		expect(qualifyImageReference('builder', new Set(['builder']))).toBeUndefined();
		expect(qualifyImageReference('Builder', new Set(['builder']))).toBeUndefined();
	});
});

describe('qualifyDockerfileImageReferences', () => {
	it('rewrites only the image token of each FROM line, preserving flags, stage names, spacing, and every other line', () => {
		const dockerfile = [
			'# syntax=docker/dockerfile:1',
			'ARG BASE=apify/actor-node:20',
			'FROM --platform=$BUILDPLATFORM   apify/actor-node:20 AS builder',
			'RUN echo "FROM inside a string is not an instruction"',
			'from python:3.11-slim as tools',
			'FROM ${BASE}',
			'FROM builder',
			'FROM scratch',
			'COPY --from=builder /app /app',
			'FROM ghcr.io/org/image:1',
			'',
		].join('\n');

		const result = qualifyDockerfileImageReferences(dockerfile);

		expect(result.dockerfile.split('\n')).toEqual([
			'# syntax=docker/dockerfile:1',
			'ARG BASE=apify/actor-node:20',
			'FROM --platform=$BUILDPLATFORM   docker.io/apify/actor-node:20 AS builder',
			'RUN echo "FROM inside a string is not an instruction"',
			'from docker.io/library/python:3.11-slim as tools',
			'FROM ${BASE}',
			'FROM builder',
			'FROM scratch',
			'COPY --from=builder /app /app',
			'FROM ghcr.io/org/image:1',
			'',
		]);
		expect(result.qualified).toEqual([
			{ from: 'apify/actor-node:20', to: 'docker.io/apify/actor-node:20' },
			{ from: 'python:3.11-slim', to: 'docker.io/library/python:3.11-slim' },
		]);
	});

	it('does not treat a later stage name as a stage before it is declared, and keeps a Windows line ending intact', () => {
		const result = qualifyDockerfileImageReferences('FROM base\r\nFROM alpine AS base\r\n');
		expect(result.dockerfile).toBe('FROM docker.io/library/base\r\nFROM docker.io/library/alpine AS base\r\n');
	});

	it('returns the Dockerfile unchanged, with nothing qualified, when every FROM is already qualified', () => {
		const dockerfile = 'FROM docker.io/apify/actor-node:20\nCMD ["node", "main.js"]\n';
		expect(qualifyDockerfileImageReferences(dockerfile)).toEqual({ dockerfile, qualified: [] });
	});
});
