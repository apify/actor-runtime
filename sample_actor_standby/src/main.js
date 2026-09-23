import { createServer } from 'node:http';
import { URL } from 'node:url';

import { Actor, log } from 'apify';

await Actor.init();

if (Actor.config.get('metaOrigin') !== 'STANDBY') {
	log.info(`Not started in Standby mode - send HTTP requests to ${Actor.config.get('standbyUrl')} instead.`);
	await Actor.exit();
} else {
	const port = Actor.config.get('standbyPort');
	let served = 0;

	const server = createServer(async (req, res) => {
		// The platform's readiness probe; any answer tells it the server is up.
		if (req.headers['x-apify-container-server-readiness-probe']) {
			res.end('ready\n');
			return;
		}
		const url = new URL(req.url, 'http://localhost');
		const name = url.searchParams.get('name') ?? 'world';
		served += 1;
		await Actor.pushData({ path: url.pathname, name, servedAt: new Date().toISOString() });
		log.info(`Served ${req.method} ${url.pathname} (request #${served} of this run)`);
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ greeting: `Hello, ${name}!`, runId: Actor.config.get('actorRunId'), served }));
	});

	// An idle standby run is wound down with an `aborting` event; the SDK then exits on its own.
	Actor.on('aborting', () => {
		log.info(`Shutting down after serving ${served} requests.`);
		server.close();
	});

	server.listen(port, () => log.info(`Standby server listening on port ${port}`));
}
