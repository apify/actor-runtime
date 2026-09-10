/**
 * Docker's own rule for a short image name - no registry host in front of it means Docker Hub
 * (`docker.io`), and a single-segment name lives under `library/` - applied by the runtime to the
 * `FROM` lines of every Actor Dockerfile it builds. Docker applies that rule implicitly; Podman leaves
 * it to the host's `registries.conf`, which on a stock Debian/Ubuntu install names no search registry
 * at all, so `FROM apify/actor-node:20` fails there with "short-name did not resolve to an alias".
 * Qualifying the reference up front makes the Dockerfile mean the same thing on every engine, exactly
 * as it does on the platform.
 *
 * Left alone: `scratch`, a reference to an earlier build stage (`FROM base`), anything containing a
 * variable (`FROM ${BASE}`), and any reference that already names a registry (a first path component
 * with a `.` or `:`, or `localhost`).
 */

export interface QualifiedImageReference {
	from: string;
	to: string;
}

export interface QualifyDockerfileResult {
	dockerfile: string;
	qualified: QualifiedImageReference[];
}

const DOCKER_HUB = 'docker.io';

/** Whether the first path component of a multi-component name is a registry host, per
 * `distribution/reference`'s `splitDockerDomain`. */
function hasRegistry(nameWithoutDigest: string): boolean {
	const firstSlash = nameWithoutDigest.indexOf('/');
	if (firstSlash === -1) return false;
	const first = nameWithoutDigest.slice(0, firstSlash);
	return first.includes('.') || first.includes(':') || first === 'localhost';
}

/** The fully-qualified form of `ref`, or undefined when it must be left as written. */
export function qualifyImageReference(ref: string, stageNames: ReadonlySet<string>): string | undefined {
	if (ref === '' || ref.includes('$')) return undefined;
	if (ref.toLowerCase() === 'scratch' || stageNames.has(ref.toLowerCase())) return undefined;
	const nameWithoutDigest = ref.split('@')[0]!;
	if (hasRegistry(nameWithoutDigest)) return undefined;
	return nameWithoutDigest.includes('/') ? `${DOCKER_HUB}/${ref}` : `${DOCKER_HUB}/library/${ref}`;
}

/** Splits an instruction's arguments on whitespace, remembering where each token starts. */
function tokenize(text: string): Array<{ token: string; start: number }> {
	const tokens: Array<{ token: string; start: number }> = [];
	const pattern = /\S+/g;
	for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
		tokens.push({ token: match[0], start: match.index });
	}
	return tokens;
}

export function qualifyDockerfileImageReferences(dockerfile: string): QualifyDockerfileResult {
	const stageNames = new Set<string>();
	const qualified: QualifiedImageReference[] = [];
	const lines = dockerfile.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const instruction = /^(\s*)from\s+/i.exec(line);
		if (!instruction) continue;

		const argsStart = instruction[0].length;
		const tokens = tokenize(line.slice(argsStart));
		// Flags such as `--platform=...` come first; the image reference is the first non-flag token.
		const imageIndex = tokens.findIndex(({ token }) => !token.startsWith('--'));
		if (imageIndex === -1) continue;
		const image = tokens[imageIndex]!;

		const asIndex = tokens.findIndex(({ token }, index) => index > imageIndex && token.toLowerCase() === 'as');
		const stageName = asIndex !== -1 ? tokens[asIndex + 1]?.token : undefined;

		const replacement = qualifyImageReference(image.token, stageNames);
		if (replacement) {
			const at = argsStart + image.start;
			lines[i] = `${line.slice(0, at)}${replacement}${line.slice(at + image.token.length)}`;
			qualified.push({ from: image.token, to: replacement });
		}
		if (stageName) stageNames.add(stageName.toLowerCase());
	}

	return { dockerfile: lines.join('\n'), qualified };
}
