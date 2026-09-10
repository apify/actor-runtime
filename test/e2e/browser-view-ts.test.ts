import { PLAYWRIGHT_BASE_IMAGE } from './helpers/docker.js';
import { CONSOLE_URL_FROM_ACTOR, describeBrowserViewSuite } from './helpers/browser-view-suite.js';

describeBrowserViewSuite({
	dir: 'sample_actor_playwright',
	label: 'TypeScript',
	baseImage: PLAYWRIGHT_BASE_IMAGE,
	input: (maxRequests) => ({ maxRequestsPerCrawl: maxRequests, startUrls: [{ url: CONSOLE_URL_FROM_ACTOR }] }),
	withToggleClearedCase: true,
});
