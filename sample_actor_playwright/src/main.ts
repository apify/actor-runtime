/**
 * Playwright + Crawlee sample Actor for actor-runtime, based on Apify's `ts-crawlee-playwright-chrome`
 * template (https://github.com/apify/actor-templates). The one deliberate departure from the template is
 * `headless: false` below - see README.md for why, and for how to watch this browser from your own
 * browser through the runtime's browser view.
 */

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

// Apify Proxy is used only when the runtime handed this run a proxy password (actor-runtime's README,
// "Apify Proxy"); a plain local run without one connects directly instead of failing the access check.
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
	// One page at a time keeps the dataset item count exactly equal to maxRequestsPerCrawl (with higher
	// concurrency, pages already in flight when the limit is reached still finish and overshoot), and
	// keeps the mirrored display showing one browser window at a time.
	maxConcurrency: 1,
	// Headful, always - not only when someone is watching. The base image runs this Actor under Xvfb, so a
	// headful Chrome works without a real display, and actor-runtime's browser view (when turned on for this
	// Actor) mirrors that display without touching the browser: what a site sees is identical whether the
	// mirror is on, off, or being watched. Headful Chrome is also the less fingerprintable mode.
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
