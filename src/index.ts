import { bootstrapStorage } from './storage/bootstrap.js';
import { openRegistries } from './storage/registries.js';
import { reconcileOrphanedJobs } from './services/runs.js';
import { createDriver } from './driver/index.js';
import { createApiServer } from './api/server.js';
import { attachEventsWebSocket } from './api/events-ws.js';
import { handleStandbyUpgrade } from './api/standby-proxy.js';
import { handleContainerUpgrade } from './api/container-proxy.js';
import { closeProxiedUpgrades } from './api/http-proxy.js';
import { createConsoleServer } from './console/server.js';
import { attachBrowserViewWebSocket } from './console/browser-view-ws.js';
import { startLogFlusher } from './services/logs.js';
import { startWebhookDispatcher } from './services/webhook-dispatches.js';
import { startScheduler } from './services/scheduler.js';
import { buildDto, runDto } from './api/dto/actors.js';
import { gracefulShutdown } from './shutdown.js';
import { API_PORT, CONSOLE_PORT, DEFAULT_DATA_DIR, HOSTED } from './config.js';
import { HostedAuth } from './hosted/auth.js';
import { createHostedServer } from './hosted/server.js';
import { HOSTED_LIMITATIONS } from './hosted/limitations.js';

async function main(): Promise<void> {
	bootstrapStorage(DEFAULT_DATA_DIR);
	await openRegistries();
	// No default user is created here any more - users are created ad-hoc, per previously-unseen token,
	// at the first API request that carries it (`services/users.ts: getOrCreateUserForToken()`,
	// `cli.md`'s User bootstrap).
	startLogFlusher();

	const driver = await createDriver();
	// Ahead of the reconciliation, so the runs and builds it aborts fire their webhooks.
	await startWebhookDispatcher({ apiPort: API_PORT, runResource: (run) => runDto(run), buildResource: buildDto });
	await reconcileOrphanedJobs(driver);
	// After it, so a schedule due at start sees its previous run already aborted.
	await startScheduler({ driver });

	const apiApp = createApiServer({ driver });
	const consoleApp = createConsoleServer({ driver });

	// Hosted: one listener (the standby port) for both, behind real-token auth (`requirements/hosted.md`).
	const ownerId = process.env.APIFY_USER_ID;
	if (HOSTED && !ownerId) throw new Error('Hosted mode needs APIFY_USER_ID (set by the Apify platform).');
	const hostedServer = HOSTED
		? createHostedServer({
				apiApp,
				consoleApp,
				auth: new HostedAuth({
					ownerId: ownerId!,
					apiBaseUrl: process.env.APIFY_API_BASE_URL ?? 'https://api.apify.com',
				}),
			})
		: undefined;
	const apiServer = hostedServer ? hostedServer.listen(API_PORT) : apiApp.listen(API_PORT);
	const consoleServer = hostedServer ?? consoleApp.listen(CONSOLE_PORT);
	// Upgrades on the same API server/port - no second port (`system.md`); see
	// `api/events-ws.ts`'s own doc comment for why this attaches here rather than inside `createApiServer`
	// (Express never sees an `upgrade` event, so this needs the actual `http.Server` `listen()` returned).
	const eventsWebSocketServer = attachEventsWebSocket(
		apiServer,
		(req, socket, head) =>
			handleContainerUpgrade(driver, req, socket, head) || handleStandbyUpgrade(driver, req, socket, head),
	);
	// Two `upgrade` listeners cannot share a server (each destroys paths that are not its own), and the
	// browser view is unavailable when hosted anyway.
	const browserViewWebSocketServer = hostedServer ? undefined : attachBrowserViewWebSocket(consoleServer);

	if (HOSTED) {
		console.log(`actor-runtime hosted as a standby Actor: API and console on port ${API_PORT}`);
		console.warn(`Not available when hosted:\n${HOSTED_LIMITATIONS.map((line) => `  - ${line}`).join('\n')}`);
	} else {
		console.log(`actor-runtime API listening on port ${API_PORT}`);
		console.log(`actor-runtime console listening on port ${CONSOLE_PORT}`);
	}
	// An agent that started this runtime reads this output and has no other reason to go looking.
	console.log(
		`actor-runtime Agent Skill (how to drive this runtime): ` +
			`'apify runtime skill --install', or GET http://localhost:${API_PORT}/actor-runtime/skill`,
	);
	if (!driver.available) {
		console.warn(`Docker is not available: ${driver.unavailableReason}. Builds and runs will fail fast.`);
	}

	const shutdown = async () => {
		closeProxiedUpgrades();
		await gracefulShutdown({ apiServer, consoleServer, eventsWebSocketServer, browserViewWebSocketServer });
		process.exit(0);
	};

	process.on('SIGTERM', () => void shutdown());
	process.on('SIGINT', () => void shutdown());
}

main().catch((error) => {
	console.error('Fatal error during startup:', error);
	process.exit(1);
});
