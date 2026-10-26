import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	addCaBundleToDockerfile,
	certificatesMissingFrom,
	readSystemCaBundle,
} from '../../src/services/dockerfile-extra-ca.js';

const COPY = 'COPY actor-runtime-ca-bundle.pem /actor-runtime-ca-bundle.pem';
const B = '/actor-runtime-ca-bundle.pem';
const ENV_ALL = `ENV NODE_EXTRA_CA_CERTS=${B} SSL_CERT_FILE=${B} REQUESTS_CA_BUNDLE=${B} PIP_CERT=${B} CURL_CA_BUNDLE=${B} GIT_SSL_CAINFO=${B} AWS_CA_BUNDLE=${B}`;
const ENV_NODE_ONLY = `ENV NODE_EXTRA_CA_CERTS=${B}`;

describe('addCaBundleToDockerfile (a build trusts the CA bundle in every stage)', () => {
	it('adds the bundle and the trust variables right after the FROM line', () => {
		const result = addCaBundleToDockerfile('FROM node:20\nCOPY . .\nRUN npm install', { replaceRoots: true });
		expect(result.dockerfile).toBe(`FROM node:20\n${COPY}\n${ENV_ALL}\nCOPY . .\nRUN npm install`);
		expect(result.stages).toBe(1);
	});

	it('sets only the additive variable when the bundle does not hold the system roots', () => {
		const result = addCaBundleToDockerfile('FROM node:20', { replaceRoots: false });
		expect(result.dockerfile).toBe(`FROM node:20\n${COPY}\n${ENV_NODE_ONLY}`);
	});

	it('does it in every stage of a multi-stage build', () => {
		const result = addCaBundleToDockerfile(
			'FROM node:20 AS build\nRUN npm ci\nFROM node:20\nCOPY --from=build /a /a',
			{
				replaceRoots: true,
			},
		);
		expect(result.stages).toBe(2);
		expect(result.dockerfile.split(COPY).length - 1).toBe(2);
	});

	it('keeps ARG lines before the first FROM ahead of it, and is case-insensitive', () => {
		const result = addCaBundleToDockerfile('ARG BASE=node:20\nfrom ${BASE}\nRUN true', { replaceRoots: false });
		expect(result.dockerfile).toBe(`ARG BASE=node:20\nfrom \${BASE}\n${COPY}\n${ENV_NODE_ONLY}\nRUN true`);
	});

	it('places the instructions after a FROM that continues over several lines', () => {
		const result = addCaBundleToDockerfile('FROM \\\n  node:20 \\\n  AS base\nRUN true', { replaceRoots: false });
		expect(result.dockerfile).toBe(`FROM \\\n  node:20 \\\n  AS base\n${COPY}\n${ENV_NODE_ONLY}\nRUN true`);
	});

	it('reports no stages for a file without FROM', () => {
		expect(addCaBundleToDockerfile('# empty', { replaceRoots: true }).stages).toBe(0);
	});
});

describe('readSystemCaBundle', () => {
	it('returns the first candidate that exists, and undefined when none does', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ca-bundle-'));
		try {
			await writeFile(join(dir, 'second.pem'), 'SECOND');
			await writeFile(join(dir, 'third.pem'), 'THIRD');
			expect(
				await readSystemCaBundle([join(dir, 'missing.pem'), join(dir, 'second.pem'), join(dir, 'third.pem')]),
			).toBe('SECOND');
			expect(await readSystemCaBundle([join(dir, 'missing.pem')])).toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('certificatesMissingFrom', () => {
	const cert = (body: string) => `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;

	it('keeps only the candidates the roots lack, once each, whatever the line wrapping', () => {
		const roots = `${cert('AAAA')}\n${cert('BBBB')}\n`;
		const candidates = `# host\n${cert('BB\nBB')}\n${cert('CCCC')}\n${cert('CCCC')}\n${cert('AAAA')}`;
		expect(certificatesMissingFrom(roots, candidates)).toEqual([cert('CCCC')]);
	});

	it('is empty when the host trusts nothing the roots do not, and for text without certificates', () => {
		expect(certificatesMissingFrom(cert('AAAA'), cert('AAAA'))).toEqual([]);
		expect(certificatesMissingFrom(cert('AAAA'), 'nothing here')).toEqual([]);
	});

	it('treats every candidate as missing when there are no roots', () => {
		expect(certificatesMissingFrom('', cert('AAAA'))).toEqual([cert('AAAA')]);
	});
});
