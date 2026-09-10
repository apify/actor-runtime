# Test layers

- Beside the mandatory CLI-only end-to-end test below, the implementation also carries unit tests (pure logic; no Docker, no storage on disk) and integration tests (a real HTTP server backed by real on-disk storage, driven by a real `apify-client`, covering storages CRUD, request-queue conformance, actors/builds/runs/logs, and the console pages). They do not replace the mandatory e2e test; they run without Docker so the suite works in environments where the Docker-dependent e2e test cannot.

# Continuous integration

- CI (GitHub Actions) runs on every pull request and on pushes to the main branches: build, lint, format check, and all test layers, with the mandatory CLI-only e2e suite below executing against a real Docker daemon. A missing daemon fails the CI job - the e2e suite never silently skips.
- CI runs each e2e file as its own job, in parallel; locally the files run one after another (each starts a runtime container on the fixed ports).

# Mandatory end-to-end tests

- All end-to-end tests can use only Apify cli commands to emulate user workflow.
- **One narrow, explicit exception**: the debug-mode e2e test (`actor-driver.md`'s "Debug mode" section)
  may connect directly to the published debug port to emulate an IDE attaching a debugger, since no
  `apify` command can express that. Every other assertion in that test (the pause, the attach log line,
  the abort) still goes through `apify` commands only, same as every other e2e case.
- **A second narrow exception of the same kind**: the browser-view e2e test may open the console's viewer
  page and its websocket directly, to emulate a developer's browser opening the view. Everything else in it
  goes through `apify` commands.
- For asserting the test results, the tests must inspect the return values of the Apify cli commands.
- The e2e suite requires a reachable Docker daemon (it builds and runs real Actor containers) and
  detects its absence, failing in such case.
- The same suite must pass unchanged against Podman, rootful or rootless (`CONTAINER_CLI=podman`, plus
  `DOCKER_HOST` when the engine's socket is not at its default path). CI's per-file jobs run against Docker,
  rootless Podman 4, and rootless Podman 3.4 (Ubuntu 22.04's stock package) - the browser-view tests included.
- The sample Actors crawl a live site (`https://crawlee.dev/` by default), so the e2e suite also requires outbound network access from Actor containers. This is separate from the runtime's own offline capability (see the offline notes in `system.md` and `cli.md`).
- CI must pre-pull the sample Actors' base images (`apify/actor-node:24`, `apify/actor-python:3.13`, and `python:3.11-slim` for `sample_actor_crawler`) before running the e2e suite, so push/call assertion timing is not dominated by first-time image pulls. The browser-view e2e test pre-pulls the two Playwright samples' base images itself, and its Actors crawl the runtime's own console rather than a public site, so no e2e run depends on the public internet beyond image pulls.

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
