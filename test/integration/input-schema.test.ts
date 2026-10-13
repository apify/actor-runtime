/**
 * Input validation and defaults at run start, over the real HTTP server and a real `apify-client`
 * (`actor-driver.md`'s "Input schema, validation and defaults"). Builds are seeded directly, the way
 * the rest of the run-start integration tests do, so no Docker daemon is needed: what matters here is
 * what the API answers and what lands in the run's `INPUT` record, neither of which involves the driver.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fixedBuildOutcomeDriver, startTestServer, type TestServerHandle } from './helpers/test-server.js';
import { getRegistries } from '../../src/storage/registries.js';
import { generateId } from '../../src/storage/ids.js';
import { recordTaggedBuild, updateActor } from '../../src/services/actors.js';
import { runBuildInBackground } from '../../src/services/builds.js';
import type { InputSchema, SourceFile } from '../../src/storage/entities.js';

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
	},
	required: [],
};

describe('input validation and defaults (via real apify-client)', () => {
	let server: TestServerHandle;

	beforeEach(async () => {
		server = await startTestServer();
	});

	afterEach(async () => {
		await server.close();
	});

	/** Seeds a tagged, successful build - with or without an input schema - for `actorId`. */
	async function seedBuild(
		actorId: string,
		userId: string,
		inputSchema?: InputSchema,
		tag = 'latest',
	): Promise<void> {
		const { builds } = getRegistries();
		const buildId = generateId();
		const buildNumber = '0.0.1';
		await builds.set(buildId, {
			id: buildId,
			userId,
			actorId,
			versionNumber: '0.0',
			buildNumber,
			tag,
			status: 'SUCCEEDED',
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			imageId: `fake-image:${tag}`,
			...(inputSchema ? { inputSchema } : {}),
		});
		await updateActor(actorId, (current) => recordTaggedBuild(current, tag, buildId, buildNumber));
	}

	async function storedInput(runId: string): Promise<unknown> {
		const run = await server.client.run(runId).get();
		const record = await server.client.keyValueStore(run!.defaultKeyValueStoreId).getRecord('INPUT');
		return record?.value;
	}

	it("fills the schema's defaults into the run's INPUT, keeping what the caller sent", async () => {
		const actor = await server.client.actors().create({ name: 'defaults-actor' });
		await seedBuild(actor.id, actor.userId, SAMPLE_SCHEMA);

		const run = await server.client.actor(actor.id).start({ maxPages: 7 });
		expect(await storedInput(run.id)).toEqual({ maxPages: 7, startUrl: 'https://crawlee.dev/' });
	});

	it('writes the defaults even for a run started with no input at all', async () => {
		const actor = await server.client.actors().create({ name: 'no-input-actor' });
		await seedBuild(actor.id, actor.userId, SAMPLE_SCHEMA);

		// No body at all on the wire - the raw endpoint, since `apify-client` always sends the object
		// it is given.
		const response = await fetch(`${server.baseUrl}/v2/actors/${actor.id}/runs?token=${server.token}`, {
			method: 'POST',
		});
		expect(response.status).toBe(201);
		const { data } = (await response.json()) as { data: { id: string } };
		expect(await storedInput(data.id)).toEqual({ startUrl: 'https://crawlee.dev/', maxPages: 2 });
	});

	it("rejects an input the schema does not accept, with the platform's error type and message", async () => {
		const actor = await server.client.actors().create({ name: 'invalid-input-actor' });
		await seedBuild(actor.id, actor.userId, SAMPLE_SCHEMA);

		await expect(server.client.actor(actor.id).start({ maxPages: 0 })).rejects.toMatchObject({
			statusCode: 400,
			type: 'invalid-input',
			message: 'Input is not valid: Field input.maxPages must be >= 1',
		});

		// Nothing was started: a rejected input never creates a run.
		const runs = await server.client.actor(actor.id).runs().list();
		expect(runs.items).toHaveLength(0);
	});

	it('rejects a non-object and a non-JSON body against a schema', async () => {
		const actor = await server.client.actors().create({ name: 'malformed-input-actor' });
		await seedBuild(actor.id, actor.userId, SAMPLE_SCHEMA);
		const url = `${server.baseUrl}/v2/actors/${actor.id}/runs?token=${server.token}`;

		const array = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '[1,2]',
		});
		expect(array.status).toBe(400);
		expect(await array.json()).toEqual({
			error: { type: 'invalid-input', message: 'The input JSON must be object, got "array" instead.' },
		});

		const text = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: '{"maxPages":1}',
		});
		expect(text.status).toBe(400);
		expect(await text.json()).toEqual({
			error: { type: 'invalid-input', message: 'Actor input must have content type "application/json".' },
		});

		const broken = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{oops',
		});
		expect(broken.status).toBe(400);
		expect(((await broken.json()) as { error: { message: string } }).error.message).toContain(
			'Cannot parse input JSON body:',
		);
	});

	it('leaves the input untouched for a build that carries no input schema', async () => {
		const actor = await server.client.actors().create({ name: 'schemaless-actor' });
		await seedBuild(actor.id, actor.userId);

		// Not valid against SAMPLE_SCHEMA at all - and accepted, byte for byte, because this build has
		// no schema to validate against.
		const run = await server.client.actor(actor.id).start({ maxPages: 0, whatever: 'anything' });
		expect(await storedInput(run.id)).toEqual({ maxPages: 0, whatever: 'anything' });
	});

	it('validates against the schema of the build the run actually resolved, not the newest one', async () => {
		const actor = await server.client.actors().create({ name: 'two-tag-actor' });

		// `latest` demands maxPages >= 1; `beta` has no schema at all.
		await seedBuild(actor.id, actor.userId, SAMPLE_SCHEMA);
		await seedBuild(actor.id, actor.userId, undefined, 'beta');

		await expect(server.client.actor(actor.id).start({ maxPages: 0 })).rejects.toMatchObject({
			statusCode: 400,
			type: 'invalid-input',
		});

		const betaRun = await server.client.actor(actor.id).start({ maxPages: 0 }, { build: 'beta' });
		expect(await storedInput(betaRun.id)).toEqual({ maxPages: 0 });
	});

	it('records the schema found in the pushed source on the build, and fails the build on a broken one', async () => {
		const actor = await server.client.actors().create({ name: 'building-actor' });
		const { actors, builds } = getRegistries();

		/** Runs a real build (driver stubbed out at the `docker build` itself) over `sourceFiles`, so the
		 * schema really is resolved from the pushed source the way a pushed Actor's would be. */
		const build = async (buildId: string, sourceFiles: SourceFile[]): Promise<void> => {
			await builds.set(buildId, {
				id: buildId,
				userId: actor.userId,
				actorId: actor.id,
				versionNumber: '0.0',
				buildNumber: '0.0.1',
				tag: 'latest',
				status: 'READY',
				startedAt: new Date().toISOString(),
			});
			await runBuildInBackground(
				fixedBuildOutcomeDriver({ imageId: 'built-image:latest' }),
				(await actors.get(actor.id))!,
				{ versionNumber: '0.0', buildTag: 'latest', sourceType: 'SOURCE_FILES', sourceFiles },
				(await builds.get(buildId))!,
				{ tag: 'latest', useCache: true },
			);
		};

		const goodBuildId = 'goodBuildId12345g';
		await build(goodBuildId, [
			{ name: 'main.js', format: 'TEXT', content: 'console.log(1)' },
			{ name: '.actor/input_schema.json', format: 'TEXT', content: JSON.stringify(SAMPLE_SCHEMA) },
		]);

		expect((await builds.get(goodBuildId))?.status).toBe('SUCCEEDED');
		expect((await builds.get(goodBuildId))?.inputSchema).toEqual(SAMPLE_SCHEMA);
		expect(await server.client.log(goodBuildId).get()).toContain('Using the input schema from');

		// End to end from that build: a run against it is validated, and gets the defaults.
		await expect(server.client.actor(actor.id).start({ maxPages: 0 })).rejects.toMatchObject({
			statusCode: 400,
			type: 'invalid-input',
		});
		const run = await server.client.actor(actor.id).start({ maxPages: 5 });
		expect(await storedInput(run.id)).toEqual({ maxPages: 5, startUrl: 'https://crawlee.dev/' });

		// A build whose schema is invalid fails, with the reason in both its status message and its log -
		// rather than producing an image whose every later run would silently skip validation.
		const brokenBuildId = 'brokenBuildId123b';
		await build(brokenBuildId, [
			{
				name: '.actor/input_schema.json',
				format: 'TEXT',
				content: JSON.stringify({
					title: 'Missing a description',
					type: 'object',
					schemaVersion: 1,
					properties: { maxPages: { title: 'Max pages', type: 'integer' } },
				}),
			},
		]);
		const broken = await server.client.build(brokenBuildId).get();
		expect(broken?.status).toBe('FAILED');
		expect(broken?.statusMessage).toContain('is not valid');
		expect(await server.client.log(brokenBuildId).get()).toContain('.actor/input_schema.json');
		expect((await builds.get(brokenBuildId))?.inputSchema).toBeUndefined();
	});
});
