import { describe, expect, it } from 'vitest';

import {
	addCaBundleToDockerfile,
	certificatesMissingFrom,
	publicRootCertificates,
} from '../../src/services/dockerfile-extra-ca.js';

const COPY = 'COPY actor-runtime-ca-bundle.pem /actor-runtime-ca-bundle.pem';
const B = '/actor-runtime-ca-bundle.pem';
const ENV = [
	'NODE_EXTRA_CA_CERTS',
	'SSL_CERT_FILE',
	'REQUESTS_CA_BUNDLE',
	'PIP_CERT',
	'CURL_CA_BUNDLE',
	'GIT_SSL_CAINFO',
	'AWS_CA_BUNDLE',
]
	.map((name) => `ARG ${name}=${B}`)
	.join('\n');

describe('addCaBundleToDockerfile (a build trusts the CA bundle in every stage, through build arguments only)', () => {
	it('never sets ENV, so the image and its runs keep the environment the Actor defined', () => {
		expect(addCaBundleToDockerfile('FROM node:20').dockerfile).not.toMatch(/^ENV /m);
	});

	it('adds the bundle and the trust variables right after the FROM line', () => {
		const result = addCaBundleToDockerfile('FROM node:20\nCOPY . .\nRUN npm install');
		expect(result.dockerfile).toBe(`FROM node:20\n${COPY}\n${ENV}\nCOPY . .\nRUN npm install`);
		expect(result.stages).toBe(1);
	});

	it('does it in every stage of a multi-stage build', () => {
		const result = addCaBundleToDockerfile(
			'FROM node:20 AS build\nRUN npm ci\nFROM node:20\nCOPY --from=build /a /a',
		);
		expect(result.stages).toBe(2);
		expect(result.dockerfile.split(COPY).length - 1).toBe(2);
	});

	it('keeps ARG lines before the first FROM ahead of it, and is case-insensitive', () => {
		const result = addCaBundleToDockerfile('ARG BASE=node:20\nfrom ${BASE}\nRUN true');
		expect(result.dockerfile).toBe(`ARG BASE=node:20\nfrom \${BASE}\n${COPY}\n${ENV}\nRUN true`);
	});

	it('places the instructions after a FROM that continues over several lines', () => {
		const result = addCaBundleToDockerfile('FROM \\\n  node:20 \\\n  AS base\nRUN true');
		expect(result.dockerfile).toBe(`FROM \\\n  node:20 \\\n  AS base\n${COPY}\n${ENV}\nRUN true`);
	});

	it('reports no stages for a file without FROM', () => {
		expect(addCaBundleToDockerfile('# empty').stages).toBe(0);
	});
});

describe('publicRootCertificates', () => {
	it("is Node's bundled Mozilla roots as one PEM text", () => {
		const roots = publicRootCertificates();
		expect(roots.match(/BEGIN CERTIFICATE/g)!.length).toBeGreaterThan(100);
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
