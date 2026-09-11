/** Fixed, non-configurable ports (`system.md`): identical on every start, no env var overrides them. */
export const API_PORT = 3333;
export const CONSOLE_PORT = 3000;

/** The DNS alias every Actor container resolves the runtime's own API by, on the `apify-local` network. */
export const CONTAINER_API_ALIAS = 'apify-api';
export const CONTAINER_API_BASE_URL = `http://${CONTAINER_API_ALIAS}:${API_PORT}`;

/** Base for the events-websocket URL every Actor container is given (`ACTOR_EVENTS_WEBSOCKET_URL` /
 * `APIFY_ACTOR_EVENTS_WS_URL`, `services/runs.ts: buildEnv`) - the same host:port as
 * `CONTAINER_API_BASE_URL`, just `ws://` instead of `http://`: the events endpoint upgrades on the
 * existing API server (`api/events-ws.ts`), not a second port (`system.md`'s fixed-ports contract). */
export const CONTAINER_EVENTS_WS_BASE_URL = `ws://${CONTAINER_API_ALIAS}:${API_PORT}`;

/** Host-facing base URL for the local console UI (fixed port, `system.md`) - used only to build the
 * `consoleUrl` field storage DTOs return (the real platform's equivalent points at
 * `console.apify.com`; this points at the one console this runtime actually serves). The path appended
 * after this base uses the real platform's URL shape (e.g. `/storage/datasets/:id`), which the console
 * server redirects to its own page - see `console.md`. */
export const CONSOLE_BASE_URL = `http://localhost:${CONSOLE_PORT}`;

export const DEFAULT_DATA_DIR = process.env.ACTOR_RUNTIME_DATA_DIR ?? '/data';

/** Where the Python debug-mode payload lives inside the runtime's own image. Read fresh on every call
 * (not cached) so tests can point `ACTOR_RUNTIME_DEBUGPY_PAYLOAD_DIR` at a fixture directory. */
function debugpyPayloadDir(): string {
	return process.env.ACTOR_RUNTIME_DEBUGPY_PAYLOAD_DIR ?? '/opt/apify-debug-payload';
}

/** The prebuilt tar `docker-driver.ts` streams into a Python debug run's container. */
export function debugpyPayloadTarPath(): string {
	return `${debugpyPayloadDir()}/debugpy-payload.tar`;
}

/** The debugpy version baked into the payload, written at image-build time so it never drifts from a
 * hardcoded copy. */
export function debugpyVersionFilePath(): string {
	return `${debugpyPayloadDir()}/debugpy-version.txt`;
}

/** Read fresh on every call, like `debugpyPayloadDir()`, so tests can point it at a fixture directory. */
function browserViewerPayloadDir(): string {
	return process.env.ACTOR_RUNTIME_BROWSER_VIEWER_PAYLOAD_DIR ?? '/opt/apify-browser-viewer';
}

/** The browser-view sidecar's root filesystem, `docker import`ed on first use. */
export function browserViewerRootfsTarPath(): string {
	return `${browserViewerPayloadDir()}/rootfs.tar`;
}

/** Content hash of `rootfs.tar`, used as the imported image's tag. */
export function browserViewerVersionFilePath(): string {
	return `${browserViewerPayloadDir()}/version.txt`;
}

/** Where this runtime's own Agent Skill (`skills/actor-runtime/SKILL.md`) lives inside the image -
 * served by `api/routes/skill.ts` and copied out of a stopped image by `apify runtime skill`. Read
 * fresh on every call, like the payload dirs above, so tests can point it at a fixture. Relative to the
 * image's WORKDIR (`/usr/src/app`), which is also the repo root when running from a checkout. */
export function skillFilePath(): string {
	return process.env.ACTOR_RUNTIME_SKILL_PATH ?? 'skills/actor-runtime/SKILL.md';
}
