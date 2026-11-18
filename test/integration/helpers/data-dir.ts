import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Every file under `dir` whose content includes `needle`, the runtime's key file aside. */
export async function filesContaining(dir: string, needle: string): Promise<string[]> {
	const hits: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile() || entry.name === '.token-vault.key') continue;
		const path = join(entry.parentPath, entry.name);
		if ((await readFile(path, 'utf8')).includes(needle)) hits.push(path);
	}
	return hits;
}
