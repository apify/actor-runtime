import { PLAYWRIGHT_BASE_IMAGE } from './helpers/docker.js';
import { describeBrowserViewSuite } from './helpers/browser-view-suite.js';

describeBrowserViewSuite({
	dir: 'sample_actor_playwright',
	label: 'TypeScript',
	baseImage: PLAYWRIGHT_BASE_IMAGE,
	input: (maxRequests) => ({ maxRequestsPerCrawl: maxRequests }),
	withToggleClearedCase: true,
});
