/**
 * Unauthenticated, unlike the rest of `/actor-runtime/*`: explaining how to authenticate here is one of
 * the things the skill does, so a caller must be able to read it before it has a token.
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

/** Not a YAML parser - no dependency for two scalar fields. Missing fields come back empty rather than
 * throwing, since a malformed header is no reason to refuse to serve the body. */
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
		// YAML's folded scalar: an indented line continues the value above it.
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
		// A deployment fault (an image built without `skills/`), not a bad request.
		throw new ApiError(500, 'skill-unavailable', `This runtime's Agent Skill was not found at ${path}`);
	}

	return { ...parseSkillFrontmatter(content), content };
}

/** `router` is expected **not** to have `auth()` registered on it, unlike every other route module's. */
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
