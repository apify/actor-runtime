/** Asserts on the shipped `SKILL.md` rather than a fixture: it must keep parsing into a usable
 * `name`/`description`, or every agent that installs it loses its discovery stage. */
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';

import { startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { parseSkillFrontmatter } from '../../src/api/routes/skill.js';

describe('GET /actor-runtime/skill', () => {
	let server: TestServerHandle;

	beforeEach(async () => {
		server = await startTestServer();
	});

	afterEach(async () => {
		await server.close();
		delete process.env.ACTOR_RUNTIME_SKILL_PATH;
	});

	it('serves the shipped SKILL.md as raw markdown, without a token', async () => {
		const expected = await readFile('skills/actor-runtime/SKILL.md', 'utf8');

		const response = await axios.get(`${server.baseUrl}/actor-runtime/skill`);

		expect(response.status).toBe(200);
		expect(response.headers['content-type']).toContain('text/markdown');
		expect(response.data).toBe(expected);
	});

	it('serves the parsed frontmatter alongside the content for format=json', async () => {
		const response = await axios.get(`${server.baseUrl}/actor-runtime/skill?format=json`);

		expect(response.status).toBe(200);
		expect(response.data.data.name).toBe('apify-actor-runtime');
		// An agent matches a task against the description; an empty one never activates.
		expect(response.data.data.description.length).toBeGreaterThan(40);
		expect(response.data.data.content).toContain('# Local Apify Actor runtime');
	});

	it('is served at the /v2 mount too, like the rest of the namespace', async () => {
		const response = await axios.get(`${server.baseUrl}/v2/actor-runtime/skill`);

		expect(response.status).toBe(200);
		expect(response.data).toContain('# Local Apify Actor runtime');
	});

	it('answers 500 when the image carries no skill file', async () => {
		process.env.ACTOR_RUNTIME_SKILL_PATH = 'skills/actor-runtime/DOES-NOT-EXIST.md';

		const response = await axios.get(`${server.baseUrl}/actor-runtime/skill`, { validateStatus: () => true });

		expect(response.status).toBe(500);
		expect(response.data.error.type).toBe('skill-unavailable');
	});

	it('still authenticates every other route in the namespace', async () => {
		const response = await axios.get(`${server.baseUrl}/actor-runtime/api-fallback`, {
			validateStatus: () => true,
		});

		expect(response.status).toBe(401);
	});
});

describe('parseSkillFrontmatter', () => {
	it('folds a wrapped description back onto one line', () => {
		const { name, description } = parseSkillFrontmatter(
			['---', 'name: demo', 'description: first line', '  second line', '---', '', '# Body'].join('\n'),
		);

		expect(name).toBe('demo');
		expect(description).toBe('first line second line');
	});

	it('returns empty fields rather than throwing when there is no frontmatter', () => {
		expect(parseSkillFrontmatter('# Body only')).toEqual({ name: '', description: '' });
	});
});
