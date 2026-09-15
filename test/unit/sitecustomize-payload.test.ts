/**
 * Guards in `docker/sitecustomize.py`, the file injected into a Python debug run's container
 * (`actor-driver.md`'s "Debug mode"). Run against a real `python3` with a stub `debugpy` that imitates
 * the one behavior that matters: `listen()` spawns debugpy's adapter as a child Python, started from
 * inside the payload directory and inheriting PYTHONPATH, so it imports `sitecustomize.py` again.
 * Unguarded, that child starts debugpy too - endlessly, with the port never bound and the Actor never
 * running. The marker file alone did not cover it: a non-root Actor user cannot create the marker in the
 * root-owned payload directory, and the "try anyway" fallback then let every adapter start its own.
 *
 * No Docker (`test.md`'s test layers): a temp directory plays the payload directory, and the unwritable
 * case drops to an unprivileged uid when the suite itself runs as root.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SITECUSTOMIZE = join(REPO_ROOT, 'docker', 'sitecustomize.py');
const PORT = '5678';
/** `nobody` - only used when the suite itself runs as root, where file modes cannot block a write. */
const UNPRIVILEGED_UID = 65534;

/** A `debugpy` that records what it was asked to do and re-enacts the adapter spawn. */
const DEBUGPY_STUB = `import os
import subprocess
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))


def _record(line):
    with open(os.environ['DEBUGPY_STUB_CALLS'], 'a') as handle:
        handle.write(line + '\\n')


def listen(address):
    _record('listen {0}:{1}'.format(address[0], address[1]))
    # What the real debugpy does: a child Python whose argv[0] is inside the payload directory, with
    # this process's environment inherited wholesale.
    subprocess.run([sys.executable, os.path.join(_HERE, 'adapter'), '--for-server'], check=True)


def wait_for_client():
    _record('wait_for_client')
`;

const ADAPTER_STUB = `import os

with open(os.environ['DEBUGPY_STUB_CALLS'], 'a') as handle:
    handle.write('adapter-ran\\n')
`;

let workDir = '';

interface PythonRun {
	stdout: string;
	stderr: string;
	status: number | null;
	calls: string[];
}

/** A payload directory (`sitecustomize.py` + the stub `debugpy`) plus the Actor's own script. */
function makePayload(): { payloadDir: string; actorScript: string; callsFile: string } {
	workDir = mkdtempSync(join(tmpdir(), 'sitecustomize-test-'));
	const payloadDir = join(workDir, 'payload');
	mkdirSync(join(payloadDir, 'debugpy', 'adapter'), { recursive: true });
	writeFileSync(join(payloadDir, 'sitecustomize.py'), readFileSync(SITECUSTOMIZE));
	writeFileSync(join(payloadDir, 'debugpy', '__init__.py'), DEBUGPY_STUB);
	writeFileSync(join(payloadDir, 'debugpy', 'adapter', '__main__.py'), ADAPTER_STUB);
	const actorScript = join(workDir, 'actor.py');
	writeFileSync(actorScript, "print('ACTOR CODE RAN')\n");
	const callsFile = join(workDir, 'calls.txt');
	writeFileSync(callsFile, '');
	// Readable by whoever the Python below runs as - `nobody` when this suite runs as root.
	execFileSync('chmod', ['-R', 'a+rX', workDir]);
	chmodSync(workDir, 0o755);
	chmodSync(callsFile, 0o666);
	// Writable by default; the unwritable case below locks it down.
	chmodSync(payloadDir, 0o777);
	return { payloadDir, actorScript, callsFile };
}

function runPython(args: string[], payloadDir: string, callsFile: string, env: NodeJS.ProcessEnv = {}): PythonRun {
	const result = spawnSync('python3', args, {
		encoding: 'utf8',
		timeout: 20_000,
		// A fresh environment: only what a debug run's container actually carries.
		env: {
			PATH: process.env.PATH ?? '/usr/bin:/bin',
			PYTHONPATH: payloadDir,
			APIFY_ACTOR_RUNTIME_DEBUG_PORT: PORT,
			DEBUGPY_STUB_CALLS: callsFile,
			...env,
		},
		// Only root may switch uid; below it the directory modes already stop the write.
		...(process.getuid?.() === 0 ? { uid: UNPRIVILEGED_UID, gid: UNPRIVILEGED_UID } : {}),
	});
	const calls = readFileSync(callsFile, 'utf8')
		.split('\n')
		.filter((line) => line.length > 0);
	return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status, calls };
}

describe('docker/sitecustomize.py: exactly one process in the container starts debugpy', () => {
	beforeAll(() => {
		const probe = spawnSync('python3', ['-c', 'pass'], { encoding: 'utf8' });
		if (probe.error || probe.status !== 0) {
			throw new Error('These tests need a `python3` on PATH to run the injected payload against.');
		}
	});

	afterEach(() => {
		if (!workDir) return;
		// The unwritable case leaves a directory its own owner cannot delete out of.
		execFileSync('chmod', ['-R', 'u+rwX', workDir]);
		rmSync(workDir, { recursive: true, force: true });
		workDir = '';
	});

	it('starts debugpy once in the Actor process, and the adapter it spawns does not start another', () => {
		const { payloadDir, actorScript, callsFile } = makePayload();

		const run = runPython([actorScript], payloadDir, callsFile);

		expect(run.stderr).toContain(`debugpy is listening on 0.0.0.0:${PORT}`);
		expect(run.stdout).toContain('ACTOR CODE RAN');
		expect(run.calls).toEqual([`listen 0.0.0.0:${PORT}`, 'adapter-ran', 'wait_for_client']);
		expect(existsSync(join(payloadDir, '.debugpy-started'))).toBe(true);
	});

	it('still starts debugpy exactly once when the start-marker cannot be created (non-root Actor image)', () => {
		const { payloadDir, actorScript, callsFile } = makePayload();
		// What an image running the Actor as `myuser` sees: the marker guard is gone, the env flag is all
		// that is left.
		chmodSync(payloadDir, 0o555);

		const run = runPython([actorScript], payloadDir, callsFile);

		// Fails loudly rather than passing vacuously if the directory turned out to be writable.
		expect(run.stderr).toContain('could not create the debugpy start-marker');
		expect(run.stderr).toContain(`debugpy is listening on 0.0.0.0:${PORT}`);
		expect(run.stdout).toContain('ACTOR CODE RAN');
		expect(run.calls).toEqual([`listen 0.0.0.0:${PORT}`, 'adapter-ran', 'wait_for_client']);
	});

	it('is shipped in a payload directory a non-root Actor user can write the marker into', () => {
		// Extracted as root; a non-root Actor user still has to be able to create the marker beside it.
		const dockerfile = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8');
		expect(dockerfile).toMatch(/chmod 1777 "\/payload\/root\/\$\{PAYLOAD_DIR\}"/);
	});

	it("never starts debugpy in debugpy's own adapter, even with no marker and no inherited flag", () => {
		const { payloadDir, callsFile } = makePayload();

		const run = runPython([join(payloadDir, 'debugpy', 'adapter')], payloadDir, callsFile);

		expect(run.calls).toEqual(['adapter-ran']);
		expect(run.stderr).not.toContain('debugpy is listening');
		expect(existsSync(join(payloadDir, '.debugpy-started'))).toBe(false);
	});
});
