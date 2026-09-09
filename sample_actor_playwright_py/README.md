## Python Playwright sample Actor (headful Chromium, watchable through actor-runtime's browser view)

A Crawlee for Python `PlaywrightCrawler` Actor built from Apify's
[`python-crawlee-playwright`](https://github.com/apify/actor-templates/tree/master/templates/python-crawlee-playwright)
template. It crawls `max_requests_per_crawl` same-hostname pages from `start_urls` with a real Chromium and pushes
`{ url, title, h1s, h2s, h3s }` per page to the default dataset.

The one deliberate change from the template: the crawler runs **headful** (`headless=False`). The template
hard-codes `headless=True`, and a headless browser draws nothing on any display - so a browser-view mirror of an
unmodified template Actor is a black screen. The `apify/actor-python-playwright` base image runs the Actor under
Xvfb (its entrypoint wraps `CMD` in `xvfb-run`), so a headful Chromium works in the container with no real display.
That is what makes the browser watchable, and it is also why watching it changes nothing: the browser always draws
on that virtual display, and the runtime's browser view only reads the display's pixels.

### Run it locally and watch the browser

With actor-runtime started and the CLI pointed at it (see the repository README):

```bash
cd sample_actor_playwright_py
apify push
# turn the mirror on once for this Actor (view-only; add `"interactive": true` to also send mouse/keyboard)
apify api POST /actor-runtime/browser-view/<actorId> --body '{"enabled": true}'
apify call --input '{"max_requests_per_crawl": 5}'
```

`<actorId>` is `.actor.id` from `apify push --json`. The run's log prints the viewer URL,
`http://localhost:3000/runs/<runId>/browser` - open it in your own browser to watch Chromium crawl, live. The
same link is on the run's page in the console (`http://localhost:3000/runs/<runId>`).

What a crawled site can observe is the same with the mirror on, off, or being watched - see
`sample_actor_playwright/README.md` (the TypeScript twin of this Actor) and `requirements/actor-driver.md`,
"Browser view".

Note that the explicit `headless=False` also wins over the `APIFY_HEADLESS=1` default the Apify platform sets,
so this Actor runs headful there too. If you prefer headless on the platform, derive `headless` from
`Actor.is_at_home()` or an input field instead.
