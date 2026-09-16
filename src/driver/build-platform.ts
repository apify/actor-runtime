/**
 * The architecture the Apify platform builds and runs on, and the one a build is retried for when the
 * host's own has no base image to build from - several Apify base images (both Playwright ones) are
 * published for `linux/amd64` only, so on arm64 the build dies on its first `FROM`. The engine emulates
 * amd64 there (Rosetta on Apple Silicon), slower than native.
 */
export const COMPATIBILITY_BUILD_PLATFORM = 'linux/amd64';

/** "Nothing here matches the platform I asked for", as Docker's classic builder, BuildKit (which
 * names the image, not the platform) and Podman each word it - Podman calls the list a manifest list
 * up to 4 and an image index from 5 on, with the architecture quoted only in the newer wording. */
const MISSING_MANIFEST_PATTERNS: readonly RegExp[] = [
	/no matching manifest for (?<platform>\S+)/i,
	/no match for platform in manifest/i,
	/no image found in (?:manifest list|image index) for architecture "?(?<platform>[^",\s]+)/i,
];

const COMPATIBILITY_ARCHITECTURE = /amd64|x86[_-]?64/i;

/** Whether a rebuild for {@link COMPATIBILITY_BUILD_PLATFORM} is worth trying. Matched on message text
 * because the engine gives nothing else; false when the failure already names amd64 (an arm64-only base
 * image on an amd64 host), where the retry would fail identically. */
export function isMissingManifestForBuildPlatform(message: string): boolean {
	for (const pattern of MISSING_MANIFEST_PATTERNS) {
		const match = pattern.exec(message);
		if (!match) continue;
		const platform = match.groups?.platform;
		return !platform || !COMPATIBILITY_ARCHITECTURE.test(platform);
	}
	return false;
}

/** Written before the second attempt starts, so the reason is logged even if that attempt fails too. */
export function compatibilityBuildNotice(failure: string): string {
	return (
		`A base image of this Actor has no build for this machine's architecture: ${failure.trim()}\n` +
		`Retrying the build for ${COMPATIBILITY_BUILD_PLATFORM}, the architecture the Apify platform builds and ` +
		`runs Actors on. The engine emulates it (Rosetta on Apple Silicon), so the image builds and runs here ` +
		`as it would on the platform, only slower - an engine with no amd64 emulation fails instead.`
	);
}
