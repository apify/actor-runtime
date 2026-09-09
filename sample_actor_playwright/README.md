## Playwright sample Actor (headful Chrome, watchable through actor-runtime's browser view)

A `PlaywrightCrawler` Actor built from Apify's
[`ts-crawlee-playwright-chrome`](https://github.com/apify/actor-templates/tree/master/templates/ts-crawlee-playwright-chrome)
template. It crawls `maxRequestsPerCrawl` same-hostname pages from `startUrls` with a real Chrome and pushes
`{ url, title }` per page to the default dataset.

The one deliberate change from the template: the crawler always runs **headful** (`headless: false`). The
`apify/actor-node-playwright-chrome` base image runs the Actor under Xvfb (its entrypoint wraps `CMD` in
`xvfb-run`), so a headful Chrome works in the container with no real display. That is what makes the browser
watchable, and it is also why watching it changes nothing: the browser always draws on that virtual display,
and the runtime's browser view only reads the display's pixels.

### Run it locally and watch the browser

With actor-runtime started and the CLI pointed at it (see the repository README):

```bash
cd sample_actor_playwright
apify push
# turn the mirror on once for this Actor (view-only; add `"interactive": true` to also send mouse/keyboard)
apify api POST /actor-runtime/browser-view/<actorId> --body '{"enabled": true}'
apify call --input '{"maxRequestsPerCrawl": 5}'
```

`<actorId>` is `.actor.id` from `apify push --json`. The run's log prints the viewer URL,
`http://localhost:3000/runs/<runId>/browser` - open it in your own browser to watch Chrome crawl, live. The same
link is on the run's page in the console (`http://localhost:3000/runs/<runId>`), and the toggle is also a form
on the Actor's console page.

What a crawled site can observe is the same with the mirror on, off, or being watched: the Actor container's
image, command, environment, network and ports are those of an ordinary run (the only addition is sharing its
`/tmp/.X11-unix` socket directory with the mirror), Chrome runs headful on the same Xvfb display either way, and
the mirror is an ordinary X client that reads the framebuffer - it injects nothing into the browser, and Chrome
has no way to tell whether anyone is connected. Full mechanics: `requirements/actor-driver.md`, "Browser view".

Note that the explicit `headless: false` also wins over the `APIFY_HEADLESS=1` default the Apify platform sets,
so this Actor runs headful there too (the base image's Xvfb handles it). If you prefer headless on the platform,
derive `headless` from `Actor.isAtHome()` or an input field instead.
