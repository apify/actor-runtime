# Test layers

- Beside the mandatory CLI-only end-to-end test below, the implementation also carries unit tests (pure logic; no Docker, no storage on disk) and integration tests (a real HTTP server backed by real on-disk storage, driven by a real `apify-client`, covering storages CRUD, request-queue conformance, actors/builds/runs/logs, and the console pages). They do not replace the mandatory e2e test; they run without Docker so the suite works in environments where the Docker-dependent e2e test cannot.

# Continuous integration

- CI (GitHub Actions) runs on every pull request and on pushes to the main branches: build, lint, format check, and all test layers, with the mandatory CLI-only e2e suite below executing against a real Docker daemon. A missing daemon fails the CI job - the e2e suite never silently skips.
- CI runs each e2e file as its own job, in parallel; locally the files run one after another (each starts a runtime container on the fixed ports).
- **arm64 is covered by CI**: one job runs the "Actor full dev loop" file below on a native arm64 Linux runner, which builds and runs the runtime image on that architecture - otherwise nothing outside the dispatch-only release workflow would catch an arm64 break. It runs that one file: both Playwright base images are published for amd64 only, so the browser-based cases cannot run there.
- **macOS is covered by CI too** (`system.md` lists it as a supported host): one job runs the "Actor full dev loop" file below on a macOS runner, against a real engine installed on that runner. It runs that one file - macOS runner minutes are expensive and its engine runs in a VM, so the leg protects the core flow and leaves the rest of the matrix to Linux. The runner must be an Intel one: a container engine on macOS needs a Linux VM, and GitHub's Apple silicon runners cannot start one at all.

# Mandatory end-to-end tests

- All end-to-end tests can use only Apify cli commands to emulate user workflow.
- **One narrow, explicit exception**: the debug-mode e2e test (`actor-driver.md`'s "Debug mode" section)
  may connect directly to the published debug port to emulate an IDE attaching a debugger, since no
  `apify` command can express that. Every other assertion in that test (the pause, the attach log line,
  the abort) still goes through `apify` commands only, same as every other e2e case.
- **A second narrow exception of the same kind**: the browser-view e2e test may open the console's viewer
  page and its websocket directly, to emulate a developer's browser opening the view. Everything else in it
  goes through `apify` commands.
- The all-modes e2e test below has both modes on at once and so carries both exceptions, for the same
  reasons; everything else in it goes through `apify` commands too.
- For asserting the test results, the tests must inspect the return values of the Apify cli commands.
- The e2e suite requires a reachable Docker daemon (it builds and runs real Actor containers) and
  detects its absence, failing in such case.
- The same suite must pass unchanged against Podman, rootful or rootless, selected through
  `CONTAINER_CLI` and `DOCKER_HOST`. CI runs every e2e file, browser view included, against Docker and
  against both the oldest and the newest supported Podman.
- The sample Actors crawl a live site (`https://crawlee.dev/` by default; the browser-based cases point at Apify's own `https://demo-webstore.apify.org/`, whose links are server-rendered rather than hydrated in), so the e2e suite also requires outbound network access from Actor containers. This is separate from the runtime's own offline capability (see the offline notes in `system.md` and `cli.md`).
- CI must pre-pull the sample Actors' base images (`apify/actor-node:24`, `apify/actor-python:3.13`, and `python:3.11-slim` for `sample_actor_crawler`) before running the e2e suite, so push/call assertion timing is not dominated by first-time image pulls. The browser-view and all-modes e2e tests pre-pull the Playwright samples' base images themselves.

## Actor full dev loop

Test case must verify full Actor development flow:

- Use sample actors (one for TypeScript actor and one Python actor)
- Push and build Actor in local actor runtime `apify push`
- Run each sample Actor in the local actor runtime with `apify call --input '{"maxPages":N}'` for at least two different values of `N`, waiting for each run to finish
- Assert via `apify datasets info <default dataset id>` that the default dataset's `itemCount` tracks `N` - the assertion is input-dependent, not just "some items exist"

## Browser view

- For each Playwright sample Actor (`sample_actor_playwright`, `sample_actor_playwright_py`): push, turn browser view on, start a run
- Assert the run log names the viewer URL, the view is reachable while the run is going, the run finishes `SUCCEEDED` with an input-dependent `itemCount`, and the view is gone once the run has ended
- With the toggle cleared, a plain `apify call` of the same Actor runs with no browser-view line in its log

## All advanced modes at once

The three per-Actor modes above are independent toggles that a developer can have on together, so one
e2e case runs a single Actor with **debug mode, a live dev folder, and browser view all on at once**
(`sample_actor_playwright` - the only sample whose image is both headful and started through `node`
directly, as debug mode requires):

- Register the dev folder, turn debug mode and browser view on, then start one run
- Assert that run's own log announces all three, and that the run really is paused before any user code
- Attach to the published debug port and release the pause, as an IDE would
- Assert the released run executes the source compiled into the dev folder (not the built image's), that
  the view is reachable while it crawls, and that it finishes `SUCCEEDED` with an input-dependent
  `itemCount` - none of the three modes changing the crawl's own outcome
