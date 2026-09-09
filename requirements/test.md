# Test layers

- Beside the mandatory CLI-only end-to-end test below, the implementation also carries unit tests (pure logic; no Docker, no storage on disk) and integration tests (a real HTTP server backed by real on-disk storage, driven by a real `apify-client`, covering storages CRUD, request-queue conformance, actors/builds/runs/logs, and the console pages). They do not replace the mandatory e2e test; they run without Docker so the suite works in environments where the Docker-dependent e2e test cannot.

# Continuous integration

- CI (GitHub Actions) runs on every pull request and on pushes to the main branches: build, lint, format check, and all test layers, with the mandatory CLI-only e2e suite below executing against a real Docker daemon. A missing daemon fails the CI job - the e2e suite never silently skips.

# Mandatory end-to-end tests

- All end-to-end tests can use only Apify cli commands to emulate user workflow.
- **One narrow, explicit exception**: the debug-mode e2e test (`actor-driver.md`'s "Debug mode" section)
  may connect directly to the published debug port to emulate an IDE attaching a debugger, since no
  `apify` command can express that. Every other assertion in that test (the pause, the attach log line,
  the abort) still goes through `apify` commands only, same as every other e2e case.
- **A second narrow exception of the same kind**: the browser-view e2e test (`actor-driver.md`'s "Browser
  view" section) may open the console's viewer websocket (`console.md`'s "Browser view page") directly and
  read the mirror's RFB greeting off it, plus fetch the console pages it links, to emulate a developer's
  browser opening the viewer - no `apify` command can express that either. The push, the toggle, the run
  start, the log, the run status and the dataset count in that test all still go through `apify` commands.
- For asserting the test results, the tests must inspect the return values of the Apify cli commands.
- The e2e suite requires a reachable Docker daemon (it builds and runs real Actor containers) and
  detects its absence, failing in such case.
- The sample Actors crawl a live site (`https://crawlee.dev/` by default), so the e2e suite also requires outbound network access from Actor containers. This is separate from the runtime's own offline capability (see the offline notes in `system.md` and `cli.md`).
- CI must pre-pull the sample Actors' base images (`apify/actor-node:24`, `apify/actor-python:3.13`, and `python:3.11-slim` for `sample_actor_crawler`) before running the e2e suite, so push/call assertion timing is not dominated by first-time image pulls. The browser-view e2e test pre-pulls the two Playwright samples' own, much larger base images (`apify/actor-node-playwright-chrome:24-1.61.1` for `sample_actor_playwright`, `apify/actor-python-playwright:3.14-1.61.0` for `sample_actor_playwright_py`) itself, since no other e2e case builds against them.

## Actor full dev loop

Test case must verify full Actor development flow:

- Use sample actors (one for TypeScript actor and one Python actor)
- Push and build Actor in local actor runtime `apify push`
- Run each sample Actor in the local actor runtime with `apify call --input '{"maxPages":N}'` for at least two different values of `N`, waiting for each run to finish
- Assert via `apify datasets info <default dataset id>` that the default dataset's `itemCount` tracks `N` - the assertion is input-dependent, not just "some items exist"

## Browser view

- Use both Playwright sample Actors (`sample_actor_playwright` in TypeScript, `sample_actor_playwright_py` in Python; headful Chrome/Chromium under the base image's Xvfb)
- For each: push and build it, turn browser view on for it (`apify api POST /actor-runtime/browser-view/<id>`), start a run
- Assert the run log names the viewer URL, that the viewer websocket reaches a live RFB server while the run is going (the one permitted non-CLI probe above), that the run then finishes `SUCCEEDED` with an input-dependent `itemCount` - the mirror must not change the crawl - and that the mirror is gone once the run has ended
- With the toggle cleared, a plain `apify call` of the same Actor runs as before, with no browser-view line in its log
