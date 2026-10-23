/**
 * Pulls an image from a Docker Registry v2 into a plain directory, with no container engine: manifest,
 * config and layers over HTTPS, layers unpacked with `tar` and OCI whiteouts applied by hand.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface ImageRef {
	registry: string;
	repository: string;
	reference: string;
}

export interface ImageConfig {
	env: string[];
	cmd?: string[];
	entrypoint?: string[];
	workingDir?: string;
	user?: string;
}

const DOCKER_HUB = 'registry-1.docker.io';
const MANIFEST_TYPES = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export function parseImageRef(ref: string): ImageRef {
	let rest = ref;
	let reference = 'latest';
	const digestAt = rest.indexOf('@');
	if (digestAt !== -1) {
		reference = rest.slice(digestAt + 1);
		rest = rest.slice(0, digestAt);
	} else {
		const colon = rest.lastIndexOf(':');
		if (colon > rest.lastIndexOf('/')) {
			reference = rest.slice(colon + 1);
			rest = rest.slice(0, colon);
		}
	}
	const parts = rest.split('/');
	const first = parts[0] ?? '';
	const hasRegistry = parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost');
	const registry = hasRegistry ? first : 'docker.io';
	let repository = hasRegistry ? parts.slice(1).join('/') : rest;
	if (registry === 'docker.io' && !repository.includes('/')) repository = `library/${repository}`;
	return { registry: registry === 'docker.io' ? DOCKER_HUB : registry, repository, reference };
}

function goArch(): string {
	return process.arch === 'arm64' ? 'arm64' : 'amd64';
}

interface Descriptor {
	mediaType: string;
	digest: string;
	platform?: { os: string; architecture: string };
}

class RegistrySession {
	private token: string | undefined;

	constructor(private readonly ref: ImageRef) {}

	async get(path: string, accept: string, signal?: AbortSignal): Promise<Response> {
		const url = `https://${this.ref.registry}/v2/${this.ref.repository}/${path}`;
		const attempt = () =>
			fetch(url, {
				headers: { accept, ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
				signal,
			});
		let response = await attempt();
		if (response.status === 401) {
			const challenge = response.headers.get('www-authenticate') ?? '';
			const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
			if (realm) {
				const service = /service="([^"]+)"/.exec(challenge)?.[1];
				const tokenUrl = new URL(realm);
				if (service) tokenUrl.searchParams.set('service', service);
				tokenUrl.searchParams.set('scope', `repository:${this.ref.repository}:pull`);
				const body = (await (await fetch(tokenUrl, { signal })).json()) as {
					token?: string;
					access_token?: string;
				};
				this.token = body.token ?? body.access_token;
				response = await attempt();
			}
		}
		if (!response.ok) throw new Error(`Registry answered ${response.status} for ${url}`);
		return response;
	}
}

function run(argv: string[], signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], signal });
		let out = '';
		let err = '';
		child.stdout.on('data', (d: Buffer) => (out += d.toString()));
		child.stderr.on('data', (d: Buffer) => (err += d.toString()));
		child.on('error', reject);
		child.on('close', (code) =>
			code === 0 ? resolve(out) : reject(new Error(`${argv[0]} failed: ${err.trim()}`)),
		);
	});
}

/** Unpacks one layer on top of `rootfs`, applying whiteouts (`.wh.<name>`, `.wh..wh..opq`) first. */
async function applyLayer(archive: string, mediaType: string, rootfs: string, signal?: AbortSignal): Promise<void> {
	const flag = mediaType.includes('zstd')
		? ['--zstd']
		: mediaType.includes('gzip') || mediaType.endsWith('.tar.gzip')
			? ['-z']
			: [];
	const listing = (await run(['tar', '-t', ...flag, '-f', archive], signal)).split('\n');
	for (const entry of listing) {
		const name = entry.replace(/^\.\//, '');
		const slash = name.lastIndexOf('/');
		const base = name.slice(slash + 1);
		const dir = slash === -1 ? '' : name.slice(0, slash);
		if (base === '.wh..wh..opq') {
			const target = join(rootfs, dir);
			for (const child of await readdir(target).catch(() => []))
				await rm(join(target, child), { recursive: true, force: true });
		} else if (base.startsWith('.wh.')) {
			await rm(join(rootfs, dir, base.slice(4)), { recursive: true, force: true });
		}
	}
	await run(['tar', '-x', ...flag, '--exclude=.wh.*', '-f', archive, '-C', rootfs], signal);
}

/** Pulls `ref` and unpacks it into `rootfs`; returns the image config. */
export async function pullImage(
	refText: string,
	rootfs: string,
	onLog: (line: string) => void,
	signal?: AbortSignal,
): Promise<ImageConfig> {
	const ref = parseImageRef(refText);
	const session = new RegistrySession(ref);
	let manifest = (await (await session.get(`manifests/${ref.reference}`, MANIFEST_TYPES, signal)).json()) as {
		manifests?: Descriptor[];
		config?: Descriptor;
		layers?: Descriptor[];
	};
	if (manifest.manifests) {
		const match = manifest.manifests.find(
			(m) => m.platform?.os === 'linux' && m.platform.architecture === goArch(),
		);
		if (!match) throw new Error(`Image ${refText} has no linux/${goArch()} variant`);
		manifest = (await (
			await session.get(`manifests/${match.digest}`, MANIFEST_TYPES, signal)
		).json()) as typeof manifest;
	}
	if (!manifest.config || !manifest.layers) throw new Error(`Unsupported manifest for ${refText}`);

	const config = (await (await session.get(`blobs/${manifest.config.digest}`, '*/*', signal)).json()) as {
		config?: { Env?: string[]; Cmd?: string[]; Entrypoint?: string[]; WorkingDir?: string; User?: string };
	};
	await mkdir(rootfs, { recursive: true });
	const scratch = await mkdtemp(join(tmpdir(), 'layer-'));
	try {
		for (const [index, layer] of manifest.layers.entries()) {
			onLog(`Pulling layer ${index + 1}/${manifest.layers.length} of ${refText}\n`);
			const file = join(scratch, 'layer.tar');
			const blob = await session.get(`blobs/${layer.digest}`, '*/*', signal);
			await mkdir(dirname(file), { recursive: true });
			await pipeline(Readable.fromWeb(blob.body as never), createWriteStream(file), { signal });
			await applyLayer(file, layer.mediaType, rootfs, signal);
			await rm(file, { force: true });
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
	const c = config.config ?? {};
	return {
		env: c.Env ?? [],
		cmd: c.Cmd ?? undefined,
		entrypoint: c.Entrypoint ?? undefined,
		workingDir: c.WorkingDir || undefined,
		user: c.User || undefined,
	};
}
