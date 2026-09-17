import { describe, expect, it } from 'vitest';

import {
	COMPATIBILITY_BUILD_PLATFORM,
	compatibilityBuildNotice,
	isMissingManifestForBuildPlatform,
} from '../../src/driver/build-platform.js';

describe('isMissingManifestForBuildPlatform', () => {
	it("recognizes Docker's classic-builder wording, the one an Apple Silicon host gets from an amd64-only base image", () => {
		expect(
			isMissingManifestForBuildPlatform(
				'no matching manifest for linux/arm64/v8 in the manifest list entries: no match for platform in manifest: not found',
			),
		).toBe(true);
	});

	it("recognizes BuildKit's wording, which names the image rather than the platform", () => {
		expect(
			isMissingManifestForBuildPlatform(
				'failed to solve: docker.io/apify/actor-python-playwright:3.14-1.61.0: no match for platform in manifest: not found',
			),
		).toBe(true);
	});

	it("recognizes Podman 4's wording", () => {
		expect(
			isMissingManifestForBuildPlatform(
				'no image found in manifest list for architecture arm64, variant "v8", OS "linux"',
			),
		).toBe(true);
	});

	it("recognizes Podman 5+'s wording, verbatim from Podman 6.0 on an Apple Silicon machine - it renamed the list to an image index and quoted the architecture", () => {
		expect(
			isMissingManifestForBuildPlatform(
				'creating build container: unable to copy from source docker://apify/actor-python-playwright:3.14-1.61.0: ' +
					'choosing an image from manifest list docker://apify/actor-python-playwright:3.14-1.61.0: ' +
					'no image found in image index for architecture "arm64", variant "v8", OS "linux"\n',
			),
		).toBe(true);
	});

	it('does not match an arm64-only base image on an amd64 host - the retry asks for exactly the platform that failed, so it would fail identically', () => {
		expect(
			isMissingManifestForBuildPlatform(
				'no matching manifest for linux/amd64 in the manifest list entries: no match for platform in manifest: not found',
			),
		).toBe(false);
		expect(
			isMissingManifestForBuildPlatform('no image found in manifest list for architecture amd64, OS "linux"'),
		).toBe(false);
		expect(
			isMissingManifestForBuildPlatform('no image found in image index for architecture "amd64", OS "linux"'),
		).toBe(false);
	});

	it('does not match an ordinary build failure', () => {
		expect(isMissingManifestForBuildPlatform("The command '/bin/sh -c npm ci' returned a non-zero code: 1")).toBe(
			false,
		);
		expect(
			isMissingManifestForBuildPlatform('pull access denied for apify/actor-node, repository does not exist'),
		).toBe(false);
	});
});

describe('compatibilityBuildNotice', () => {
	it('quotes the failure and names the platform the retry builds for', () => {
		const notice = compatibilityBuildNotice('no matching manifest for linux/arm64/v8 in the manifest list entries');

		expect(notice).toContain('no matching manifest for linux/arm64/v8');
		expect(notice).toContain(COMPATIBILITY_BUILD_PLATFORM);
	});
});
