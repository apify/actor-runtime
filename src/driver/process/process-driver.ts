/**
 * `Driver` for hosted mode (`requirements/hosted.md`): builds and runs Actors with no container engine,
 * because an Apify Actor container may not start one. Images are unpacked into directories (`registry.ts`),
 * `RUN` steps and runs execute with `chroot` (or `proot` when not root) in this container's own network
 * namespace, one port per run.
 *
 * What it gives up against `DockerDriver` is listed in `hosted/limitations.ts`.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, statSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import { basename, dirname, join, posix } from 'node:path';
import { promisify } from 'node:util';

import { allocateFreePort, sharedNetnsEnv } from '../docker-driver.js';
import { formatRuntimeLog } from '../../runtime-log.js';
import {
	DriverTimedOutError,
	type AbortRunOptions,
	type BrowserViewerHandle,
	type BrowserViewerTarget,
	type BuildContext,
	type BuildOutcome,
	type ContainerServerAddress,
	type DevFolderProbeOutcome,
	type Driver,
	type InspectedDebugTarget,
	type RunContext,
	type RunOutcome,
} from '../types.js';
import { expandVariables, parseDockerfile, parseExecForm, parseKeyValues } from './dockerfile.js';
import { pullImage, type ImageConfig } from './registry.js';

const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const IMAGE_PREFIX = 'process:';
/** proot older than 5.3 mishandles statx, which breaks Rust toolchains (rustup, cargo). */
const PROOT = process.env.ACTOR_RUNTIME_PROOT ?? 'proot';

type Sandbox = 'chroot' | 'proot';

interface Identity {
	uid?: number;
	gid?: number;
	home: string;
}

interface StoredImage extends ImageConfig {
	rootfs: string;
}

function unsupported(feature: string): Error {
	return new Error(`${feature} is not available when the runtime is hosted as an Apify Actor.`);
}

export interface ProcessDriverOptions {
	storeDir?: string;
	sandbox?: Sandbox;
}

export class ProcessDriver implements Driver {
	available = false;
	unavailableReason: string | undefined;

	private readonly storeDir: string;
	private sandbox: Sandbox = 'chroot';
	private readonly buildControllers = new Map<string, AbortController>();
	private readonly timedOutBuilds = new Set<string>();
	private readonly runs = new Map<string, ChildProcess>();
	private readonly timedOutRuns = new Set<string>();
	private readonly servers = new Map<string, ContainerServerAddress>();

	constructor(options: ProcessDriverOptions = {}) {
		this.storeDir = options.storeDir ?? process.env.ACTOR_RUNTIME_PROCESS_STORE ?? '/var/lib/actor-runtime';
		if (options.sandbox) this.sandbox = options.sandbox;
	}

	async init(): Promise<void> {
		const hasRoot = process.getuid?.() === 0;
		const probe = async (binary: string) => (await this.which(binary)) !== undefined;
		if (!(await probe('tar'))) {
			this.unavailableReason = "'tar' is not installed";
			return;
		}
		const works = async (binary: string, args: string[]) =>
			(await probe(binary)) &&
			(await promisify(execFile)(binary, args).then(
				() => true,
				() => false,
			));
		// `chroot /` proves the platform grants CAP_SYS_CHROOT, which is not a given inside an Actor;
		// `proot` proves ptrace is allowed. proot also provides /proc, which a chroot cannot mount without
		// CAP_SYS_ADMIN and which rustup, JVMs and many installers need.
		const chrootWorks = hasRoot && (await works('chroot', ['/', '/bin/true']));
		const prootWorks = await works(PROOT, ['-r', '/', '-b', '/proc', '/bin/true']);
		const wanted = process.env.ACTOR_RUNTIME_PROCESS_SANDBOX ?? 'auto';
		if (wanted === 'chroot' ? chrootWorks : wanted === 'proot' ? prootWorks : prootWorks || chrootWorks) {
			this.sandbox = wanted === 'chroot' || (wanted === 'auto' && !prootWorks) ? 'chroot' : 'proot';
		} else {
			this.unavailableReason =
				'Neither a working chroot (root with CAP_SYS_CHROOT) nor proot (needs ptrace) is available to run Actor images';
			return;
		}
		await mkdir(join(this.storeDir, 'images'), { recursive: true });
		this.available = true;
		// Children outlive a crashed parent otherwise: each run is its own process group.
		process.on('exit', () => {
			for (const child of this.runs.values()) this.kill(child, 'SIGKILL');
		});
	}

	private async which(binary: string): Promise<string | undefined> {
		if (binary.startsWith('/')) return existsSync(binary) ? binary : undefined;
		for (const dir of (process.env.PATH ?? DEFAULT_PATH).split(':')) {
			const candidate = join(dir, binary);
			if (existsSync(candidate)) return candidate;
		}
		return undefined;
	}

	private imageDir(imageId: string): string {
		return join(this.storeDir, 'images', imageId.slice(IMAGE_PREFIX.length));
	}

	// ---- build ------------------------------------------------------------------------------------

	async startBuild(ctx: BuildContext, onLog: (chunk: string) => void): Promise<BuildOutcome> {
		if (!this.available) throw new Error(this.unavailableReason ?? 'The process driver is not available');
		const controller = new AbortController();
		this.buildControllers.set(ctx.buildId, controller);
		const timer = setTimeout(() => {
			this.timedOutBuilds.add(ctx.buildId);
			controller.abort();
		}, ctx.timeoutSecs * 1000);
		const dir = join(this.storeDir, 'images', ctx.buildId);
		try {
			return await this.build(ctx, dir, onLog, controller.signal);
		} catch (error) {
			await rm(dir, { recursive: true, force: true });
			if (this.timedOutBuilds.has(ctx.buildId)) {
				throw new DriverTimedOutError(`Build exceeded its ${ctx.timeoutSecs}s timeout`);
			}
			throw error;
		} finally {
			clearTimeout(timer);
			this.timedOutBuilds.delete(ctx.buildId);
			this.buildControllers.delete(ctx.buildId);
		}
	}

	async abortBuild(buildId: string): Promise<void> {
		this.buildControllers.get(buildId)?.abort();
	}

	private async build(
		ctx: BuildContext,
		dir: string,
		onLog: (c: string) => void,
		signal: AbortSignal,
	): Promise<BuildOutcome> {
		const contextDir = join(dir, 'context');
		await mkdir(contextDir, { recursive: true });
		for (const file of ctx.sourceFiles) {
			const target = join(contextDir, file.name);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, file.format === 'BASE64' ? Buffer.from(file.content, 'base64') : file.content);
		}
		const dockerfile = await readFile(join(contextDir, ctx.dockerfilePath), 'utf8');

		const stages = new Map<string, string>();
		let stageIndex = -1;
		let rootfs = '';
		let config: ImageConfig = { env: [] };
		let env: Record<string, string> = {};
		let workdir = '/';
		let user: string | undefined;
		const args: Record<string, string> = { ...(ctx.buildArgs ?? {}) };

		for (const instruction of parseDockerfile(dockerfile)) {
			signal.throwIfAborted();
			const vars = { ...args, ...env };
			const text = expandVariables(instruction.args, vars);
			onLog(`${instruction.keyword} ${text}\n`);
			switch (instruction.keyword) {
				case 'ARG':
					for (const [key, value] of parseKeyValues(instruction.args)) {
						if (args[key] === undefined && value !== undefined) args[key] = expandVariables(value, vars);
					}
					break;
				case 'FROM': {
					const [image, , alias] = text.split(/\s+/);
					stageIndex += 1;
					rootfs = join(dir, `stage-${stageIndex}`);
					const fromStage = stages.get(image!);
					if (fromStage) {
						await cp(fromStage, rootfs, { recursive: true, verbatimSymlinks: true });
						config = JSON.parse(
							await readFile(join(dirname(fromStage), `${basename(fromStage)}.json`), 'utf8'),
						);
					} else {
						config = await pullImage(image!, rootfs, onLog, signal);
						await this.prepareRoot(rootfs);
					}
					env = Object.fromEntries(
						config.env.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]),
					);
					workdir = config.workingDir ?? '/';
					user = config.user;
					stages.set(String(stageIndex), rootfs);
					if (alias) stages.set(text.split(/\s+/).at(-1)!, rootfs);
					break;
				}
				case 'ENV':
					for (const [key, value] of parseKeyValues(instruction.args))
						env[key] = expandVariables(value ?? '', vars);
					break;
				case 'WORKDIR':
					workdir = text.startsWith('/') ? text : posix.join(workdir, text);
					await mkdir(join(rootfs, workdir), { recursive: true });
					break;
				case 'USER':
					user = text;
					break;
				case 'COPY':
				case 'ADD': {
					const from = instruction.flags.from;
					const source = from ? (stages.get(from) ?? from) : contextDir;
					const parts = text.split(/\s+/).filter(Boolean);
					const destination = parts.pop()!;
					const target = destination.startsWith('/') ? destination : posix.join(workdir, destination);
					await this.copyInto(source, parts, rootfs, target);
					if (instruction.flags.chown) {
						const owner = instruction.flags.chown;
						const env = await this.buildEnv({}, rootfs);
						const status = await this.exec(
							rootfs,
							['chown', '-R', owner, target],
							{ env, cwd: '/' },
							onLog,
							signal,
						);
						if (status !== 0) throw new Error(`COPY --chown=${owner} failed with code ${status}`);
					}
					break;
				}
				case 'RUN': {
					const exec = parseExecForm(instruction.args) ?? ['/bin/sh', '-c', instruction.args];
					const status = await this.exec(
						rootfs,
						exec,
						{ env: await this.buildEnv(env, rootfs, user), cwd: workdir, user },
						onLog,
						signal,
					);
					if (status !== 0)
						throw new Error(`The command '${exec.join(' ')}' returned a non-zero code: ${status}`);
					break;
				}
				case 'CMD':
					config.cmd = parseExecForm(instruction.args) ?? ['/bin/sh', '-c', instruction.args];
					break;
				case 'ENTRYPOINT':
					config.entrypoint = parseExecForm(instruction.args) ?? ['/bin/sh', '-c', instruction.args];
					config.cmd = undefined;
					break;
				case 'LABEL':
				case 'EXPOSE':
				case 'VOLUME':
				case 'HEALTHCHECK':
				case 'STOPSIGNAL':
				case 'SHELL':
				case 'MAINTAINER':
				case 'ONBUILD':
					break;
				default:
					onLog(formatRuntimeLog(`Ignoring unsupported Dockerfile instruction ${instruction.keyword}.`));
			}
		}
		if (!rootfs) throw new Error('The Dockerfile has no FROM instruction');

		// Only the last stage is the image; earlier ones and the context are dead weight.
		const final: StoredImage = {
			rootfs,
			env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
			cmd: config.cmd,
			entrypoint: config.entrypoint,
			workingDir: workdir,
			user,
		};
		await writeFile(join(dir, 'image.json'), JSON.stringify(final));
		await rm(contextDir, { recursive: true, force: true });
		for (let i = 0; i < stageIndex; i++) await rm(join(dir, `stage-${i}`), { recursive: true, force: true });
		return {
			imageId: `${IMAGE_PREFIX}${basename(dir)}`,
			imageWorkingDirectory: workdir !== '/' ? workdir : undefined,
		};
	}

	/** Device nodes, resolver config and hosts a chroot has no mount to provide. `apify-api` resolves to
	 * this container because every run shares its network namespace. */
	private async prepareRoot(rootfs: string): Promise<void> {
		await mkdir(join(rootfs, 'dev'), { recursive: true });
		const nodes: Array<[string, number, number]> = [
			['null', 1, 3],
			['zero', 1, 5],
			['random', 1, 8],
			['urandom', 1, 9],
			['tty', 5, 0],
		];
		for (const [name, major, minor] of nodes) {
			const path = join(rootfs, 'dev', name);
			if (existsSync(path)) continue;
			// `mknod` is in the default capability set; without it `proot` binds the host's /dev instead.
			await promisify(execFile)('mknod', ['-m', '666', path, 'c', String(major), String(minor)]).catch(
				() => undefined,
			);
		}
		await mkdir(join(rootfs, 'etc'), { recursive: true });
		await cp('/etc/resolv.conf', join(rootfs, 'etc/resolv.conf')).catch(() => undefined);
		const hosts = await readFile(join(rootfs, 'etc/hosts'), 'utf8').catch(() => '127.0.0.1 localhost\n');
		if (!hosts.includes('apify-api')) await writeFile(join(rootfs, 'etc/hosts'), `${hosts}\n127.0.0.1 apify-api\n`);
	}

	/** The user's ids and home from the image's passwd, as Docker resolves `USER`; root when unset. */
	private async identity(rootfs: string, user?: string): Promise<Identity> {
		const [account, group] = (user ?? '').split(':');
		if (!account || account === 'root' || account === '0') return { home: '/root' };
		const read = async (file: string) =>
			(await readFile(join(rootfs, 'etc', file), 'utf8').catch(() => ''))
				.split('\n')
				.map((line) => line.split(':'));
		const row = (await read('passwd')).find((f) => f[0] === account || f[2] === account);
		const gidRow = group ? (await read('group')).find((f) => f[0] === group || f[2] === group) : undefined;
		return {
			uid: Number(row?.[2] ?? account),
			gid: Number(gidRow?.[2] ?? group ?? row?.[3] ?? 0),
			home: row?.[5] || '/',
		};
	}

	private async buildEnv(
		env: Record<string, string>,
		rootfs: string,
		user?: string,
	): Promise<Record<string, string>> {
		return { PATH: DEFAULT_PATH, HOME: (await this.identity(rootfs, user)).home, ...env };
	}

	private async copyInto(sourceRoot: string, sources: string[], rootfs: string, destination: string): Promise<void> {
		const target = join(rootfs, destination);
		const targetIsDirectory = existsSync(target) && statSync(target).isDirectory();
		const intoDirectory = sources.length > 1 || destination.endsWith('/') || targetIsDirectory;
		if (intoDirectory) await mkdir(target, { recursive: true });
		for (const pattern of sources) {
			const matches: string[] = [];
			if (/[*?[{]/.test(pattern)) {
				for await (const match of glob(pattern, { cwd: sourceRoot })) matches.push(match);
			} else if (existsSync(join(sourceRoot, pattern))) {
				matches.push(pattern);
			}
			if (matches.length === 0) throw new Error(`COPY failed: no source files were found for ${pattern}`);
			for (const match of matches) {
				const from = join(sourceRoot, match);
				const isDirectory = statSync(from).isDirectory();
				const to =
					isDirectory || intoDirectory ? (isDirectory ? target : join(target, basename(from))) : target;
				await mkdir(dirname(to), { recursive: true });
				cpSync(from, to, { recursive: true, verbatimSymlinks: true });
			}
		}
	}

	// ---- execution --------------------------------------------------------------------------------

	private wrap(rootfs: string, argv: string[], opts: { cwd: string; user?: string; ids?: Identity }): string[] {
		if (this.sandbox === 'proot') {
			const identity = opts.ids?.uid !== undefined ? ['-i', `${opts.ids.uid}:${opts.ids.gid}`] : [];
			return [
				PROOT,
				...identity,
				'-r',
				rootfs,
				'-b',
				'/proc',
				'-b',
				'/dev',
				'-b',
				'/etc/resolv.conf',
				'-w',
				opts.cwd,
				...argv,
			];
		}
		const userSpec = opts.user ? [`--userspec=${opts.user}`] : [];
		// `chroot` has no working-directory flag; the shell enters it before exec-ing the real command.
		return ['chroot', ...userSpec, rootfs, '/bin/sh', '-c', `cd "$0" && exec "$@"`, opts.cwd, ...argv];
	}

	private async exec(
		rootfs: string,
		argv: string[],
		opts: { env: Record<string, string>; cwd: string; user?: string },
		onLog: (c: string) => void,
		signal?: AbortSignal,
	): Promise<number> {
		const [cmd, ...rest] = this.wrap(rootfs, argv, { ...opts, ids: await this.identity(rootfs, opts.user) });
		return new Promise((resolve, reject) => {
			const child = spawn(cmd!, rest, { env: opts.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
			signal?.addEventListener('abort', () => this.kill(child, 'SIGKILL'), { once: true });
			child.stdout.on('data', (d: Buffer) => onLog(d.toString('utf8')));
			child.stderr.on('data', (d: Buffer) => onLog(d.toString('utf8')));
			child.on('error', reject);
			child.on('close', (code, sig) =>
				signal?.aborted ? reject(signal.reason) : resolve(code ?? (sig ? 137 : 1)),
			);
		});
	}

	private kill(child: ChildProcess, signal: NodeJS.Signals): void {
		if (child.pid === undefined) return;
		try {
			process.kill(-child.pid, signal);
		} catch {
			/* already gone */
		}
	}

	async startRun(ctx: RunContext, onLog: (chunk: string) => void): Promise<RunOutcome> {
		if (!this.available) throw new Error(this.unavailableReason ?? 'The process driver is not available');
		if (ctx.devMount) throw unsupported('Running from a local dev folder');
		if (ctx.debug) throw unsupported('Debug mode');
		if (ctx.x11SocketVolume) throw unsupported('Browser view');

		const image = JSON.parse(await readFile(join(this.imageDir(ctx.imageId), 'image.json'), 'utf8')) as StoredImage;
		const port = await allocateFreePort();
		const imageEnv = Object.fromEntries(
			image.env.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]),
		);
		const env = await this.buildEnv({ ...imageEnv, ...sharedNetnsEnv(ctx.env, port) }, image.rootfs, image.user);
		const argv = [...(image.entrypoint ?? []), ...(image.cmd ?? [])];
		if (argv.length === 0) throw new Error('The image defines neither ENTRYPOINT nor CMD');

		onLog(
			formatRuntimeLog(
				`Running without a container: the ${ctx.memoryMbytes} MB memory limit is not enforced and the run shares ` +
					`this runtime's network.`,
			),
		);
		const [cmd, ...rest] = this.wrap(image.rootfs, argv, {
			cwd: image.workingDir ?? '/',
			user: image.user,
			ids: await this.identity(image.rootfs, image.user),
		});
		const child = spawn(cmd!, rest, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
		this.runs.set(ctx.runId, child);
		this.servers.set(ctx.runId, { host: '127.0.0.1', port });
		let timer: NodeJS.Timeout | undefined;
		if (ctx.timeoutSecs > 0) {
			timer = setTimeout(() => {
				this.timedOutRuns.add(ctx.runId);
				this.kill(child, 'SIGKILL');
			}, ctx.timeoutSecs * 1000);
		}
		child.stdout.on('data', (d: Buffer) => onLog(d.toString('utf8')));
		child.stderr.on('data', (d: Buffer) => onLog(d.toString('utf8')));
		try {
			const exitCode = await new Promise<number>((resolve, reject) => {
				child.on('error', reject);
				// `close`, not `exit`: it fires after stdout and stderr are drained.
				child.on('close', (code, sig) => resolve(code ?? (sig ? 128 + (sig === 'SIGTERM' ? 15 : 9) : 1)));
			});
			return { exitCode, timedOut: this.timedOutRuns.delete(ctx.runId) };
		} finally {
			if (timer) clearTimeout(timer);
			this.kill(child, 'SIGKILL'); // stragglers in the run's process group
			this.runs.delete(ctx.runId);
			this.servers.delete(ctx.runId);
		}
	}

	async abortRun(runId: string, options: AbortRunOptions = {}): Promise<void> {
		const child = this.runs.get(runId);
		if (!child) return;
		const graceSecs = options.graceSecs ?? 0;
		if (graceSecs > 0) {
			this.kill(child, 'SIGTERM');
			setTimeout(() => this.kill(child, 'SIGKILL'), graceSecs * 1000).unref();
		} else {
			this.kill(child, 'SIGKILL');
		}
	}

	async reconcileOrphans(): Promise<void> {
		// Nothing outlives this process: every child dies with it.
	}

	async containerServerAddress(runId: string): Promise<ContainerServerAddress | undefined> {
		return this.servers.get(runId);
	}

	// ---- features that need a container engine ----------------------------------------------------

	async probeDevFolder(): Promise<DevFolderProbeOutcome> {
		return { ok: false, reason: 'unreachable' };
	}

	async ensureProbeImage(): Promise<string> {
		throw unsupported('The local dev folder');
	}

	async inspectDebugTarget(): Promise<InspectedDebugTarget> {
		throw unsupported('Debug mode');
	}

	async startBrowserViewer(_target: BrowserViewerTarget): Promise<BrowserViewerHandle> {
		throw unsupported('Browser view');
	}

	async stopBrowserViewer(): Promise<void> {}
}
