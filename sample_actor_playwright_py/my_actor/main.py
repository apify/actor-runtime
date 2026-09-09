"""Playwright + Crawlee for Python sample Actor for actor-runtime, based on Apify's `python-crawlee-playwright`
template (https://github.com/apify/actor-templates). The one deliberate departure from the template is
`headless=False` below (the template hard-codes `headless=True`) - see README.md for why, and for how to
watch this browser from your own browser through the runtime's browser view.

To build Apify Actors, utilize the Apify SDK toolkit, read more at the official documentation:
https://docs.apify.com/sdk/python
"""

from __future__ import annotations

from apify import Actor
from crawlee import ConcurrencySettings
from crawlee.crawlers import PlaywrightCrawler

from .routes import router


async def main() -> None:
    """Define a main entry point for the Apify Actor.

    This coroutine is executed using `asyncio.run()`, so it must remain an asynchronous function for proper execution.
    Asynchronous execution is required for communication with Apify platform, and it also enhances performance in
    the field of web scraping significantly.
    """
    # Enter the context of the Actor.
    async with Actor:
        # Retrieve the Actor input, and use default values if not provided.
        actor_input = await Actor.get_input() or {}
        start_urls = [url.get('url') for url in actor_input.get('start_urls', [{'url': 'https://crawlee.dev/'}])]
        max_requests_per_crawl = int(actor_input.get('max_requests_per_crawl', 3))

        # Exit if no start URLs are provided.
        if not start_urls:
            Actor.log.info('No start URLs specified in Actor input, exiting...')
            await Actor.exit()

        Actor.log.info(
            f'Crawling up to {max_requests_per_crawl} page(s) with a headful Chromium, starting from {", ".join(start_urls)}.'
        )

        # Create a crawler.
        crawler = PlaywrightCrawler(
            # Limit the crawl to max requests. Remove or increase it for crawling all links.
            max_requests_per_crawl=max_requests_per_crawl,
            # One page at a time keeps the dataset item count exactly equal to max_requests_per_crawl (with
            # higher concurrency, pages already in flight when the limit is reached still finish and
            # overshoot), and keeps the mirrored display showing one browser window at a time.
            concurrency_settings=ConcurrencySettings(desired_concurrency=1, max_concurrency=1),
            # Headful, always - not only when someone is watching. The base image runs this Actor under Xvfb,
            # so a headful Chromium works without a real display, and actor-runtime's browser view (when turned
            # on for this Actor) mirrors that display without touching the browser: what a site sees is
            # identical whether the mirror is on, off, or being watched. The template's `headless=True` would
            # draw nothing on the display, so a mirror of it would be blank.
            headless=False,
            browser_launch_options={'args': ['--disable-gpu', '--no-sandbox']},
            # Set the request handler to the request router defined in routes.py.
            request_handler=router,
        )

        # Run the crawler with the starting requests.
        await crawler.run(start_urls)
