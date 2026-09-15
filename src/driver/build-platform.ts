/**
 * The architecture the Apify platform builds and runs Actors on, and the one this runtime rebuilds
 * for when the host's own architecture has no base image to build from.
 *
 * Several Apify base images are published for `linux/amd64` alone - both `apify/actor-node-playwright*`
 * and `apify/actor-python-playwright*` are - so on an arm64 host (Apple Silicon, Ampere) the build dies
 * on its very first `FROM` with "no matching manifest for linux/arm64/v8", before a single instruction
 * of the Actor's own Dockerfile runs. Docker Desktop and Podman Desktop both emulate amd64 there
 * (Rosetta on Apple Silicon), so the image the platform itself would have built is still buildable and
 * runnable locally - just slower than a native one. `DockerDriver.startBuild` retries the whole build
 * for this platform when, and only when, the host-native attempt failed that way.
 */
export const COMPATIBILITY_BUILD_PLATFORM = 'linux/amd64';

/**
 * How each engine words "this image's manifest list has nothing for the platform I asked for", with the
 * platform captured where the message names one: Docker's classic builder ("no matching manifest for
 * linux/arm64/v8 in the manifest list entries"), BuildKit (which names the image rather than the
 * platform), and Podman ("no image found in manifest list for architecture arm64, variant ...").
 */
const MISSING_MANIFEST_PATTERNS: readonly RegExp[] = [
	/no matching manifest for (?<platform>\S+)/i,
	/no match for platform in manifest/i,
	/no image found in manifest list for architecture (?<platform>[^,\s]+)/i,
];

/** Whether the platform named in a failure is already the one the retry would ask for - an arm64-only
 * base image on an amd64 host produces the same shape of message, and rebuilding it for `linux/amd64`
 * would fail identically. */
const COMPATIBILITY_ARCHITECTURE = /amd64|x86[_-]?64/i;

/**
 * Whether a failed build failed *only* because no base image exists for the platform it was built for,
 * making a rebuild for {@link COMPATIBILITY_BUILD_PLATFORM} worth trying. Matched on the message text
 * because that is all the engine gives: the failure arrives either as a rejection from
 * `docker.buildImage` or as an `error` line in the build stream, never as a typed error.
 */
export function isMissingManifestForBuildPlatform(message: string): boolean {
	for (const pattern of MISSING_MANIFEST_PATTERNS) {
		const match = pattern.exec(message);
		if (!match) continue;
		const platform = match.groups?.platform;
		return !platform || !COMPATIBILITY_ARCHITECTURE.test(platform);
	}
	return false;
}

/** The build log's explanation of the retry, written before the second attempt starts so the reason is
 * in the log even if that attempt fails too. */
export function compatibilityBuildNotice(failure: string): string {
	return (
		`A base image of this Actor has no build for this machine's architecture: ${failure.trim()}\n` +
		`Retrying the build for ${COMPATIBILITY_BUILD_PLATFORM}, the architecture the Apify platform builds and ` +
		`runs Actors on. The engine emulates it (Rosetta on Apple Silicon), so the image builds and runs here ` +
		`as it would on the platform, only slower than a native build - an engine with no amd64 emulation ` +
		`available fails instead.`
	);
}
