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
 * so the caller passes the extra CAs appended to those. The variables are build arguments, not `ENV`: the
 * build steps see them, but the image's own environment, and so every run of it, stays as the Actor
 * defined it. The bundle file itself is copied into the image and left unused.
 */
import { rootCertificates } from 'node:tls';

export const CA_BUNDLE_CONTEXT_FILE = 'actor-runtime-ca-bundle.pem';
export const CA_BUNDLE_IMAGE_PATH = '/actor-runtime-ca-bundle.pem';

/** Variables that add to a tool's own roots (Node.js) and ones that replace them: OpenSSL-based tools,
 * Python `requests`, `pip`, `curl`, `git`, the AWS SDKs. The latter need a bundle that also holds the
 * public roots. */
const CA_VARIABLES = [
	'NODE_EXTRA_CA_CERTS',
	'SSL_CERT_FILE',
	'REQUESTS_CA_BUNDLE',
	'PIP_CERT',
	'CURL_CA_BUNDLE',
	'GIT_SSL_CAINFO',
	'AWS_CA_BUNDLE',
];

/** The public roots the extra certificates are added to: Mozilla's, as bundled with the runtime's Node.js.
 * The runtime image keeps no system bundle (its slim base image has none), and a fixed set behaves the same
 * on every host. */
export function publicRootCertificates(): string {
	return rootCertificates.join('\n');
}

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/** A certificate's identity for comparison: its base64 body without whitespace, so line wrapping and
 * trailing text around the PEM block do not matter. */
function certificateBody(pem: string): string {
	return pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
}

/**
 * The certificates of `candidates` that `roots` does not already hold, each once. What a build has to be
 * given: everything else it trusts anyway, so a host that trusts nothing special adds nothing.
 */
export function certificatesMissingFrom(roots: string, candidates: string): string[] {
	const known = new Set((roots.match(PEM_CERTIFICATE) ?? []).map(certificateBody));
	const missing: string[] = [];
	for (const certificate of candidates.match(PEM_CERTIFICATE) ?? []) {
		const body = certificateBody(certificate);
		if (known.has(body)) continue;
		known.add(body);
		missing.push(certificate);
	}
	return missing;
}

export function addCaBundleToDockerfile(dockerfile: string): { dockerfile: string; stages: number } {
	const instructions = [
		`COPY ${CA_BUNDLE_CONTEXT_FILE} ${CA_BUNDLE_IMAGE_PATH}`,
		...CA_VARIABLES.map((name) => `ARG ${name}=${CA_BUNDLE_IMAGE_PATH}`),
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
