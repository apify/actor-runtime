---
name: apify-actor-runtime
description: Drive the local Apify Actor runtime - a self-contained local Apify platform that emulates the Apify API and console so Actors can be developed, run and debugged without the cloud. Covers pointing the Apify CLI at it, the no-rebuild dev-folder loop, IDE debugging, watching a Playwright/Puppeteer browser, migration testing, and relaying unimplemented calls to the real platform.
---

# Local Apify Actor runtime

These are the operating instructions for the Actor runtime the reader is talking to: a local Apify
platform serving an Apify-compatible API on `http://localhost:3333` and a console UI on
`http://localhost:3000`. It emulates the subset of the Apify API needed to develop, run and debug
Actors locally, so no change needs a rebuild on the real platform to be tried out.

It is not the Apify platform. Actors, builds, runs and storages created here exist only in this
runtime's data directory, and disappear when that directory is removed.

## Point the Apify CLI at it

Everything below is done through `apify`. Two ways to aim it:

```sh
apify runtime connect      # every command, every terminal, until 'apify runtime disconnect'
```

or, for one shell only (these take precedence over `connect` wherever they are set):

```sh
export APIFY_CLIENT_BASE_URL=http://localhost:3333
export APIFY_CONSOLE_URL=http://localhost:3000
```

Unset both, or run `apify runtime disconnect`, to talk to the real Apify platform again. Check which
one the CLI is currently aimed at with `apify runtime status`.

Any non-empty token authenticates - `apify login --token local-dev-token` is enough. Set
`APIFY_DISABLE_KEYRING=1` first in a sandbox with no OS keyring. To act as a second user, pass a
different token on a single call: `apify api v2/datasets -H '{"authorization": "Bearer OTHER"}'`.

## The normal loop

```sh
cd my-actor
apify push                      # upload + build, once
apify call --input '{"maxPages":3}'
apify runs ls --json
apify runs log <runId>
apify datasets get-items <datasetId> --format json
```

## Iterate without rebuilding (dev folder)

After that first `apify push`, the runtime registers the pushed directory as the Actor's **dev
folder** and bind-mounts it into every later run. Edit locally, recompile locally (`tsc`, or the
language equivalent), and `apify call` again - no `apify push`, no rebuild:

```sh
# edit src/main.ts
npm run build
apify call --input '{"maxPages":3}'   # picks up the new dist/
```

- A local recompile is picked up by the **next** run's container start, not by a run already going.
- `node_modules` still comes from the built image, so a new dependency in `package.json` does need a
  real `apify push`. Only source edits skip the rebuild.
- `apify call --no-dev-folder` runs once from the built image alone, leaving the registration alone.
- Register a different folder by hand with
  `apify api POST /actor-runtime/dev-folder/<actorId> --body '"/abs/path/to/src"'`; clear it with
  `--body '""'`. The path must be absolute and must exist on the machine the container engine runs
  on - the runtime rejects the call otherwise, and re-checks at every run start.

## Debug an Actor with a real IDE debugger

Turn debug mode on for the Actor once; every later `apify call` then starts paused, waiting for a
debugger, with the attach address in the run's log.

```sh
apify api POST /actor-runtime/debug/<actorId> --body '{"enabled": true}'
apify api POST /actor-runtime/debug/<actorId> --body '{"enabled": false}'   # back to normal
```

Add `"language": "node"` or `"python"` when auto-detection cannot classify the image, and `"port": <n>`
to override the default (`9229` Node, `5678` Python). Attach VS Code's "Attach" (Node) or PyCharm's
"Attach to DAP" / VS Code's "Python: Remote Attach" (Python) to `127.0.0.1:<port>`.

Two things that bite:

- **An Actor pushed with no `Dockerfile` of its own needs one.** The injected default inherits
  `CMD ["npm", "start", "--silent"]`, which debug mode refuses, because it would attach to npm rather
  than the Actor. Give the Actor a `Dockerfile` whose `CMD` invokes the interpreter directly, e.g.
  `CMD ["node", "dist/main.js"]`.
- The run's `--timeout` is not extended while you attach. Pass a larger one for a slow attach.

## Watch a Playwright/Puppeteer browser

```sh
apify api POST /actor-runtime/browser-view/<actorId> --body '{"enabled": true}'
```

Every later run prints a viewer URL, `http://localhost:3000/runs/<runId>/browser` - a live view of
the display the Actor's browser draws on. Add `"interactive": true` to also send mouse and keyboard
input. The browser must run **headful** to show anything; Apify's templates default to headless,
which shows as a black display. Disable with `{"enabled": false}`.

## Test how an Actor handles a platform migration

While a run is `RUNNING`:

```sh
apify api POST /actor-runtime/migrate/<runId>
```

The run gets the real migration experience: a `migrating` event, its container stopped a few seconds
later, then a fresh container for the same run - same run id, env vars and storages, in-memory state
gone. The Migrate button on the run's console page does the same.
`POST /v2/actor-runs/<runId>/reboot` is also implemented.

## When this runtime does not implement something

A call can fail because this runtime does not know the id, or does not implement the endpoint at
all. Such calls can be relayed to the real Apify platform instead of failing:

```sh
apify api POST /actor-runtime/api-fallback \
  --body '{"fallbackUnimplementedEnabled": true, "fallbackNotFoundEnabled": true}'
apify api GET /actor-runtime/api-fallback     # read the current state
```

Either field alone is accepted. Both default off and reset to off on every restart.

**This writes to a real Apify account.** Enabling either forwards the token the failing call carried
to the real platform, and every HTTP method is eligible - so a locally-missing `POST`/`PUT`/`DELETE`
becomes a real write. Only turn it on with a token whose account you are willing to change, and say
so before enabling it on someone's behalf. A relayed response carries `x-actor-runtime-fallback`
(which platform served it) and `x-actor-runtime-fallback-trigger` (which toggle let it through).

## Inspecting state directly

- `apify api ...` sends authenticated calls: `apify api GET v2/datasets`, `apify api GET v2/acts`.
  The `v2/` prefix and the leading slash are both optional.
- Or unauthenticated by URL: `http://localhost:3333/v2/datasets?token=TOKEN`.
- The console at `http://localhost:3000` shows the same objects, plus the dev-folder form, the
  Migrate button and the browser view.
- The runtime's data directory holds every storage, build and run record on disk. Read it freely;
  write to it only through the API, never by editing the files.

## Reading the runtime's own output

In a build or run log, everything the runtime itself says - dev-folder notices, the debug attach
line, the browser-view URL, migration markers, a run that could not start - opens with a blue
`[actor-runtime]` prefix. The Actor's own output is passed through byte for byte.
