/**
 * Makes an Actor build trust an extra CA certificate, for hosts whose outbound TLS is re-signed by a
 * proxy (corporate or sandboxed networks). A build container sees none of the host's trust settings, so
 * without this `npm install` fails with `SELF_SIGNED_CERT_IN_CHAIN`, or silently falls back to the
 * package index cached in the base image.
 *
 * There is no portable place a base image keeps its trust store (Debian, Alpine and RHEL differ, and
 * each language runtime may bring its own), so nothing is installed into the image. After every `FROM`
 * one bundle is copied in and the variables the common tools read are pointed at it. The variables that
 * replace a tool's roots (`SSL_CERT_FILE`, `pip`, `curl`) need a bundle that also holds the public roots,
 * so the caller passes the extra CA appended to the runtime's own. The variables stay in the final image,
 * so the Actor's runs trust the same CAs.
 */
import { readFile } from 'node:fs/promises';

export const CA_BUNDLE_CONTEXT_FILE = 'actor-runtime-ca-bundle.pem';
export const CA_BUNDLE_IMAGE_PATH = '/actor-runtime-ca-bundle.pem';

/** Where distributions keep their combined root bundle; the first one that exists is used. */
const SYSTEM_CA_BUNDLE_PATHS = [
	'/etc/ssl/certs/ca-certificates.crt', // Debian, Ubuntu, Alpine
	'/etc/pki/tls/certs/ca-bundle.crt', // RHEL, Fedora, CentOS
	'/etc/ssl/ca-bundle.pem', // openSUSE
	'/etc/ca-certificates/extracted/tls-ca-bundle.pem', // Arch
];

/** Variables that add to a tool's own roots; safe with any bundle. */
const ADDITIVE_CA_VARIABLES = ['NODE_EXTRA_CA_CERTS'];

/** Variables that replace a tool's roots, so the bundle must be complete: OpenSSL-based tools, Python
 * `requests`, `pip`, `curl`, `git`, the AWS SDKs. */
const REPLACING_CA_VARIABLES = [
	'SSL_CERT_FILE',
	'REQUESTS_CA_BUNDLE',
	'PIP_CERT',
	'CURL_CA_BUNDLE',
	'GIT_SSL_CAINFO',
	'AWS_CA_BUNDLE',
];

/** The runtime's own root bundle, or undefined when this image keeps it somewhere unknown. */
export async function readSystemCaBundle(
	paths: readonly string[] = SYSTEM_CA_BUNDLE_PATHS,
): Promise<string | undefined> {
	for (const path of paths) {
		try {
			return await readFile(path, 'utf8');
		} catch {
			// Next candidate.
		}
	}
	return undefined;
}

/** `replaceRoots` is false when the bundle holds only the extra CA: pointing a replacing variable at it
 * would leave that tool trusting nothing else. */
export function addCaBundleToDockerfile(
	dockerfile: string,
	{ replaceRoots }: { replaceRoots: boolean },
): { dockerfile: string; stages: number } {
	const variables = replaceRoots ? [...ADDITIVE_CA_VARIABLES, ...REPLACING_CA_VARIABLES] : ADDITIVE_CA_VARIABLES;
	const instructions = [
		`COPY ${CA_BUNDLE_CONTEXT_FILE} ${CA_BUNDLE_IMAGE_PATH}`,
		`ENV ${variables.map((name) => `${name}=${CA_BUNDLE_IMAGE_PATH}`).join(' ')}`,
	];

	const lines = dockerfile.split('\n');
	const out: string[] = [];
	let stages = 0;

	for (let i = 0; i < lines.length; i++) {
		out.push(lines[i]!);
		if (!/^\s*from\s/i.test(lines[i]!)) continue;
		// A `FROM` may continue over backslash-ended lines; the new instructions go after its last one.
		while (/\\\s*$/.test(lines[i]!) && i + 1 < lines.length) out.push(lines[++i]!);
		out.push(...instructions);
		stages++;
	}

	return { dockerfile: out.join('\n'), stages };
}
