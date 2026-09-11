/**
 * `GET /actor-runtime/skill` (`api.md`'s "Actor runtime API" section) - serves this runtime's own Agent
 * Skill, the `skills/actor-runtime/SKILL.md` baked into the image.
 *
 * Deliberately **unauthenticated**, which is why this is the one `/actor-runtime/*` route module not
 * mounted on the shared `auth()`-wrapped sub-router (`server.ts` gives it its own router registered just
 * ahead of that one). It is public documentation, and one of the things it documents is how to
 * authenticate against this runtime - an agent must be able to read it before it has a token.
 *
 * Two representations of the same file: the raw markdown by default (what a reader, or
 * `apify runtime skill`, wants), and `?format=json` for the parsed frontmatter alongside the content,
 * for a caller that wants the skill's `name`/`description` without parsing YAML itself.
 */
import { readFile } from 'node:fs/promises';

import type { Router } from 'express';

import { skillFilePath } from '../../config.js';
import { sendData } from '../envelope.js';
import { ApiError } from '../errors.js';
import { h, queryString } from '../handler.js';

export interface SkillDocument {
	name: string;
	description: string;
	content: string;
}

/**
 * Pulls `name` and `description` out of the leading YAML frontmatter block. Deliberately not a YAML
 * parser (no dependency for two scalar fields): it reads the `key: value` lines of the first `---`
 * block, joining a folded continuation line (one indented under its key, which is how a long
 * `description` is wrapped) onto the value above it. Anything it cannot find comes back as `''` rather
 * than throwing - a malformed header is not a reason to refuse to serve the body.
 */
export function parseSkillFrontmatter(markdown: string): { name: string; description: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown);
	const block = match?.[1];
	if (block === undefined) return { name: '', description: '' };

	const fields = new Map<string, string>();
	let currentKey: string | undefined;

	for (const line of block.split(/\r?\n/)) {
		const keyed = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
		const [, key, value] = keyed ?? [];
		if (key !== undefined) {
			currentKey = key;
			fields.set(key, (value ?? '').trim());
			continue;
		}
		// An indented, non-empty line continues the value above it (YAML's folded scalar): join with a
		// space, the way a YAML parser would fold it back into one line.
		if (currentKey !== undefined && /^\s+\S/.test(line)) {
			fields.set(currentKey, `${fields.get(currentKey) ?? ''} ${line.trim()}`.trim());
		}
	}

	return { name: fields.get('name') ?? '', description: fields.get('description') ?? '' };
}

async function readSkill(): Promise<SkillDocument> {
	const path = skillFilePath();

	let content: string;
	try {
		content = await readFile(path, 'utf8');
	} catch {
		// Only reachable when the image was built without `skills/` (or a test pointed the override at a
		// path that isn't there) - a deployment fault, not a request the caller got wrong.
		throw new ApiError(500, 'skill-unavailable', `This runtime's Agent Skill was not found at ${path}`);
	}

	return { ...parseSkillFrontmatter(content), content };
}

/** Mounts `GET /skill` onto `router`, matching every other route module's `mount*(router): void`
 * convention. Unlike the others, `router` here is expected **not** to have `auth()` registered on it. */
export function mountSkill(router: Router): void {
	router.get(
		'/skill',
		h(async (req, res) => {
			const skill = await readSkill();

			if (queryString(req, 'format') === 'json') {
				sendData(res, skill);
				return;
			}

			res.type('text/markdown; charset=utf-8').send(skill.content);
		}),
	);
}
