// Based on Apify's `ts-crawlee-playwright-chrome` template; the one deliberate change is `headless: false`
// (see README.md).

// For more information, see https://crawlee.dev
import { PlaywrightCrawler } from '@crawlee/playwright';
// For more information, see https://docs.apify.com/sdk/js
import { Actor, log } from 'apify';

// this is ESM project, and as such, it requires you to specify extensions in your relative imports
// read more about this here: https://nodejs.org/docs/latest-v18.x/api/esm.html#mandatory-file-extensions
// note that we need to use `.js` even when inside TS files
import { router } from './routes.js';

interface Input {
	startUrls: {
		url: string;
		method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'TRACE' | 'OPTIONS' | 'CONNECT' | 'PATCH';
		headers?: Record<string, string>;
		userData?: Record<string, unknown>;
	}[];
	maxRequestsPerCrawl: number;
}

// Initialize the Apify SDK
await Actor.init();

// Structure of input is defined in .actor/input_schema.json
const { startUrls = [{ url: 'https://crawlee.dev/' }], maxRequestsPerCrawl = 3 } =
	(await Actor.getInput<Input>()) ?? ({} as Input);

// Without a proxy password (a plain local run) the crawler connects directly instead of failing the access check.
const proxyConfiguration = process.env.APIFY_PROXY_PASSWORD
	? await Actor.createProxyConfiguration({ checkAccess: true })
	: undefined;

log.info(
	`Crawling up to ${maxRequestsPerCrawl} page(s) with a headful Chrome, starting from ${startUrls.map((s) => s.url).join(', ')}.`,
);

const crawler = new PlaywrightCrawler({
	proxyConfiguration,
	maxRequestsPerCrawl,
	requestHandler: router,
	// Keeps the dataset item count exactly equal to maxRequestsPerCrawl.
	maxConcurrency: 1,
	// Headful always, so actor-runtime's browser view has something to show and watching changes nothing.
	// The base image's Xvfb provides the display.
	headless: false,
	launchContext: {
		launchOptions: {
			args: [
				'--disable-gpu', // Mitigates the "crashing GPU process" issue in Docker containers
			],
		},
	},
});

await crawler.run(startUrls);

// Exit successfully
await Actor.exit();
