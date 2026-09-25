/**
 * Pure-function coverage for `validateDevFolderPathShape` (`actor-driver.md`'s "Registration validates
 * the path in two layers" bullet: shape pre-filter runs first - absolute POSIX path, no newline/NUL,
 * length cap, `~` never expanded). This is the only
 * layer of validation exercisable with no registries/driver at all; `setDevFolder`'s build-first and
 * host-side-probe layers are covered by `test/integration/dev-folder.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
	diagnoseUncompiledDevFolder,
	mentionsMissingModule,
	uncompiledDevFolderWarningLines,
	unknownWorkingDirectoryLine,
	validateDevFolderPathShape,
} from '../../src/services/dev-folder.js';
import type { Driver } from '../../src/driver/types.js';

describe('validateDevFolderPathShape', () => {
	it('accepts a plain absolute POSIX path', () => {
		expect(validateDevFolderPathShape('/home/dev/my-actor')).toBeNull();
	});

	it('accepts a root-level absolute path', () => {
		expect(validateDevFolderPathShape('/src')).toBeNull();
	});

	it('rejects a relative path', () => {
		expect(validateDevFolderPathShape('relative/path')).toMatch(/absolute/i);
	});

	it('does not expand a leading "~" - rejected as non-absolute, not resolved to some assumed home directory', () => {
		expect(validateDevFolderPathShape('~/my-actor')).toMatch(/absolute/i);
	});

	it('rejects a path containing a newline', () => {
		expect(validateDevFolderPathShape('/home/dev/my\nactor')).toMatch(/newline|NUL/i);
	});

	it('rejects a path containing a carriage return', () => {
		expect(validateDevFolderPathShape('/home/dev/my\ractor')).toMatch(/newline|NUL/i);
	});

	it('rejects a path containing a NUL byte', () => {
		expect(validateDevFolderPathShape('/home/dev/my\0actor')).toMatch(/newline|NUL/i);
	});

	it('rejects an unreasonably long path', () => {
		const long = '/' + 'a'.repeat(5000);
		expect(validateDevFolderPathShape(long)).toMatch(/too long/i);
	});

	it('accepts a path right at the length cap boundary', () => {
		const atCap = '/' + 'a'.repeat(4095);
		expect(atCap.length).toBe(4096);
		expect(validateDevFolderPathShape(atCap)).toBeNull();
	});
});

describe('unknownWorkingDirectoryLine', () => {
	it('names the folder, why it cannot be mounted, and both ways out', () => {
		const line = unknownWorkingDirectoryLine('/home/dev/my-actor');
		expect(line).toContain('/home/dev/my-actor');
		expect(line).toContain('no working directory of its own');
		expect(line).toContain('WORKDIR');
		// Both remedies: give the image a WORKDIR, or clear the registration.
		expect(line).toMatch(/rebuild/i);
		expect(line).toMatch(/clear the registration/i);
	});
});

describe('mentionsMissingModule', () => {
	it("matches Node's CommonJS and ESM wording for a module it could not load", () => {
		expect(mentionsMissingModule("Error: Cannot find module '/usr/src/app/dist/main.js'\n")).toBe(true);
		expect(mentionsMissingModule("  code: 'MODULE_NOT_FOUND',\n")).toBe(true);
		expect(
			mentionsMissingModule(
				"Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/usr/src/app/dist/main.js' imported from /usr/src/app/dist/index.js",
			),
		).toBe(true);
	});

	it('ignores ordinary output, including other errors', () => {
		expect(mentionsMissingModule('INFO  Starting the crawl\n')).toBe(false);
		expect(mentionsMissingModule('TypeError: Cannot read properties of undefined\n')).toBe(false);
	});
});

describe('uncompiledDevFolderWarningLines', () => {
	it('is red throughout, names the folder, the compile step, and the opt-out flag', () => {
		const lines = uncompiledDevFolderWarningLines('/home/dev/my-actor');
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(line.tone).toBe('error');
			expect(line.text.startsWith('!! ')).toBe(true);
		}
		const text = lines.map((line) => line.text).join('\n');
		expect(text).toContain('/home/dev/my-actor');
		expect(text).toContain('tsconfig.json');
		expect(text).toContain('`dist`');
		expect(text).toContain('npm run build');
		expect(text).toContain('apify call --no-dev-folder');
	});
});

describe('diagnoseUncompiledDevFolder', () => {
	const mount = { localDevFolder: '/home/dev/my-actor', imageWorkingDirectory: '/usr/src/app' };

	/** Only `devFolderHasEntry` is ever called; `entries` is what the folder "contains". */
	function driverWith(entries: string[] | Error): Driver & { asked: string[] } {
		const asked: string[] = [];
		return {
			asked,
			async devFolderHasEntry(localDevFolder, relativePath) {
				expect(localDevFolder).toBe(mount.localDevFolder);
				asked.push(relativePath);
				if (entries instanceof Error) throw entries;
				return entries.includes(relativePath);
			},
		} as unknown as Driver & { asked: string[] };
	}

	it('a tsconfig.json without a dist directory is an uncompiled TypeScript folder', async () => {
		const driver = driverWith(['tsconfig.json', 'src']);
		const lines = await diagnoseUncompiledDevFolder(driver, mount);
		expect(lines).toEqual(uncompiledDevFolderWarningLines(mount.localDevFolder));
		expect(driver.asked).toEqual(['tsconfig.json', 'dist']);
	});

	it('a compiled TypeScript folder (dist present) gets no diagnosis - the missing module is something else', async () => {
		expect(await diagnoseUncompiledDevFolder(driverWith(['tsconfig.json', 'dist']), mount)).toBeUndefined();
	});

	it('a folder with no tsconfig.json is not a TypeScript project, and dist is not even asked about', async () => {
		const driver = driverWith(['src', 'package.json']);
		expect(await diagnoseUncompiledDevFolder(driver, mount)).toBeUndefined();
		expect(driver.asked).toEqual(['tsconfig.json']);
	});

	it('a folder that cannot be inspected yields no diagnosis rather than a probe error of its own', async () => {
		expect(await diagnoseUncompiledDevFolder(driverWith(new Error('docker unreachable')), mount)).toBeUndefined();
	});
});
