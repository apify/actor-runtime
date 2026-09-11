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
- The same suite must pass unchanged against Podman, rootful or rootless, selected through
  `CONTAINER_CLI` and `DOCKER_HOST`. CI runs every e2e file, browser view included, against Docker and
  against both the oldest and the newest supported Podman.
- The sample Actors crawl a live site (`https://crawlee.dev/` by default), so the e2e suite also requires outbound network access from Actor containers. This is separate from the runtime's own offline capability (see the offline notes in `system.md` and `cli.md`).
- CI must pre-pull the sample Actors' base images (`apify/actor-node:24`, `apify/actor-python:3.13`, and `python:3.11-slim` for `sample_actor_crawler`) before running the e2e suite, so push/call assertion timing is not dominated by first-time image pulls. The browser-view e2e test pre-pulls the two Playwright samples' base images itself, and the non-standard-Actor e2e test pre-pulls its own two (`python:3.11-slim`, `busybox`) instead of the sample Actors' - it builds against neither.

## Actor full dev loop

Test case must verify full Actor development flow:

- Use sample actors (one for TypeScript actor and one Python actor)
- Push and build Actor in local actor runtime `apify push`
- Run each sample Actor in the local actor runtime with `apify call --input '{"maxPages":N}'` for at least two different values of `N`, waiting for each run to finish
- Assert via `apify datasets info <default dataset id>` that the default dataset's `itemCount` tracks `N` - the assertion is input-dependent, not just "some items exist"

## Non-standard Actors

Actors that do not look like those created from an Apify template must work exactly like the ones that
do. Covered with a sample Actor (`sample_actor_nonstandard`) that combines every difference at once - an
unusual base image (a stock `python:3.11-slim`, with no Apify SDK installed at all: the Actor drives the
runtime's API over plain HTTP from the standard library), a Dockerfile in neither default location
(found only through `.actor/actor.json`'s `dockerfile` field), a working directory that is not
`/usr/src/app`, the image's own non-root user, and a custom entry point (`ENTRYPOINT` naming a shell
script inside the working directory, with the Actor's command line in `CMD`):

- Push, build, and call it with at least two different inputs; assert the default dataset's `itemCount`
  tracks the input, the build log names the Dockerfile it resolved, and the run log shows the custom
  entry point running, in the image's own working directory, as the image's own user
- Assert the dev-folder bind mount lands on that image's own working directory, with the custom entry
  point started from the dev folder's copy when it has one and from the image's own copy when it does not
- With an image that has no working directory at all, assert the run is unaffected and that a dev folder
  registered for it is reported as unmountable in the run's log rather than silently ignored
- Assert debug mode classifies such an image from the image itself (its command names a shell script,
  not an interpreter), pauses the run, and publishes the port, with the injected payload working under
  the image's own non-root user

## Browser view

- For each Playwright sample Actor (`sample_actor_playwright`, `sample_actor_playwright_py`): push, turn browser view on, start a run
- Assert the run log names the viewer URL, the view is reachable while the run is going, the run finishes `SUCCEEDED` with an input-dependent `itemCount`, and the view is gone once the run has ended
- With the toggle cleared, a plain `apify call` of the same Actor runs with no browser-view line in its log
