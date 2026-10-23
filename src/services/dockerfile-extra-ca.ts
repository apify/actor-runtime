/**
 * Makes an Actor build trust an extra CA certificate bundle, for hosts whose outbound TLS is re-signed by
 * a proxy (corporate or sandboxed networks). A build container sees none of the host's trust settings,
 * so without this `npm install` fails with `SELF_SIGNED_CERT_IN_CHAIN`, or silently falls back to the
 * package index cached in the base image.
 *
 * After every `FROM` the bundle is copied into the stage and `NODE_EXTRA_CA_CERTS` points at it. That
 * variable only adds to Node's own roots, so it is safe for any bundle; it stays in the final image, so
 * the Actor's runs trust the same CAs. Tools that replace their roots instead (`SSL_CERT_FILE`, `pip`)
 * are not configured.
 */

export const EXTRA_CA_CONTEXT_FILE = 'actor-runtime-extra-ca.pem';
export const EXTRA_CA_IMAGE_PATH = '/actor-runtime-extra-ca.pem';

const EXTRA_CA_INSTRUCTIONS = [
	`COPY ${EXTRA_CA_CONTEXT_FILE} ${EXTRA_CA_IMAGE_PATH}`,
	`ENV NODE_EXTRA_CA_CERTS=${EXTRA_CA_IMAGE_PATH}`,
];

export function addExtraCaToDockerfile(dockerfile: string): { dockerfile: string; stages: number } {
	const lines = dockerfile.split('\n');
	const out: string[] = [];
	let stages = 0;

	for (let i = 0; i < lines.length; i++) {
		out.push(lines[i]!);
		if (!/^\s*from\s/i.test(lines[i]!)) continue;
		// A `FROM` may continue over backslash-ended lines; the new instructions go after its last one.
		while (/\\\s*$/.test(lines[i]!) && i + 1 < lines.length) out.push(lines[++i]!);
		out.push(...EXTRA_CA_INSTRUCTIONS);
		stages++;
	}

	return { dockerfile: out.join('\n'), stages };
}
