import { PYTHON_PLAYWRIGHT_BASE_IMAGE } from './helpers/docker.js';
import { CONSOLE_URL_FROM_ACTOR, describeBrowserViewSuite } from './helpers/browser-view-suite.js';

describeBrowserViewSuite({
	dir: 'sample_actor_playwright_py',
	label: 'Python',
	baseImage: PYTHON_PLAYWRIGHT_BASE_IMAGE,
	input: (maxRequests) => ({ max_requests_per_crawl: maxRequests, start_urls: [{ url: CONSOLE_URL_FROM_ACTOR }] }),
	withToggleClearedCase: false,
});
