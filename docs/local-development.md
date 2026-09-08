# Local development workflow

This guide assumes the runtime is up and your shell points the Apify CLI at it, as described in the
[Quick start](quick-start.md). It walks through the everyday loop of building an Actor against the
local runtime, then the tools the runtime adds on top of what the platform offers: running edited
source without a rebuild, attaching an IDE debugger, and rehearsing platform behaviour such as
migrations and aborts.

The loop is:

```
edit source  ->  apify push  ->  build (Docker)  ->  apify call  ->  inspect  ->  edit ...
```

Every step is the same command you would use against the real platform. The runtime differs only in
where the work happens and in a handful of local-only controls under `/actor-runtime/*`.

## 1. Set up the Actor project

Any Actor project that pushes to the platform pushes to the runtime: a `.actor/actor.json`, a
`Dockerfile` (optional, see below), and your source. The repository ships three samples that are the
tested path:

| Sample                 | Language   | What it does                                                                                |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| `sample_actor_ts`      | TypeScript | Crawls same-hostname pages from a start URL over a request queue, one dataset item per page |
| `sample_actor_py`      | Python     | Python SDK equivalent                                                                       |
| `sample_actor_crawler` | Python     | Crawlee for Python crawler                                                                  |

The runtime resolves which Dockerfile to build in this order, and states the outcome in the build log:

1. the `dockerfile` field of `.actor/actor.json`, relative to `.actor/`
2. `.actor/Dockerfile`
3. `Dockerfile` at the Actor root
4. the platform's default Dockerfile, injected for that build only

Point 4 means an Actor with no Dockerfile at all still builds. Note that the injected default inherits
the base image's `CMD ["npm", "start", "--silent"]`, which matters for debug mode (section 6).

## 2. Push and build

```bash
apify push
apify push --json      # prints the Actor id and build id, handy for scripting
```

`apify push` uploads the source files, creates or updates the Actor version, and starts a build. The
build runs against your host's Docker daemon, not Docker-in-Docker, so the layer cache is yours and
survives runtime restarts. Measured on the TypeScript sample:

| Situation                                    | Build time |
| -------------------------------------------- | ---------- |
| First build (base image pull, `npm install`) | ~30 s      |
| Re-push with no source change                | under 1 s  |
| Re-push after editing one source file        | ~4 s       |

Builds have a fixed 30 minute timeout and can be aborted:

```bash
apify api v2/actor-builds/<buildId>            # status, timings
apify api v2/actor-builds/<buildId>/log        # full build log
apify api POST v2/actor-builds/<buildId>/abort # cancels the in-flight Docker build
```

A successful build becomes the Actor's `latest` tagged build, which is what `apify call` runs by
default. Each push creates a new build record and image tag; nothing is pruned automatically, so clean
up with `docker image prune` now and then if disk space matters to you.

## 3. Run

```bash
apify call --input '{"maxPages": 3}'
apify call --input-file input.json --timeout 600 --memory 2048
apify call --json                              # run id and storage ids as JSON on stdout
```

The Actor runs as a container on your Docker daemon, on a dedicated `apify-local` network where the
runtime's API is reachable as `http://apify-api:3333`. The container gets the same environment
variables the platform sets, so the Apify SDKs work unchanged: `APIFY_TOKEN`, `APIFY_API_BASE_URL`,
the default storage ids, `ACTOR_ID`/`ACTOR_RUN_ID`, memory and CPU hints, the events websocket URL,
and `APIFY_IS_AT_HOME=1`. Environment variables declared on the Actor version are applied too, with the
platform-owned ones taking precedence.

The run's default storages are wired in over HTTP exactly as on the platform. Default run timeout is
300 seconds; set `--timeout` when a crawl needs more.

**Apify Proxy.** Set `APIFY_PROXY_PASSWORD` on the runtime container (`docker run -e ...`) to forward
it into every Actor container. If you logged in with a real token and the platform was reachable at
first contact, the runtime already knows your proxy password and forwards that instead. With neither,
the variable is simply absent.

## 4. Inspect results

Everything a run produced is available three ways.

**Console.** `http://localhost:3000` lists Actors, builds, runs, logs, and storages, with the run's
default storages linked from its detail page. Log views render ANSI colours. It accepts the URL shapes
the CLI prints for the real Console, so the links in `apify call` output open the right page.

**CLI.**

```bash
apify runs ls
apify datasets info <datasetId>
apify api v2/actor-runs/<runId>
apify api v2/actor-runs/<runId>/log
apify api v2/datasets/<datasetId>/items
apify api v2/key-value-stores/<storeId>/keys
apify api v2/key-value-stores/<storeId>/records/OUTPUT
apify api v2/request-queues/<queueId>
```

The run object also exposes its default storages under aliases like
`v2/actor-runs/<runId>/dataset/items`, and the runtime uses `v2/actors`, not the platform's `v2/acts`
alias.

**Files.** Everything lives under the mounted data directory (`./data`). Reading it is fine and is the
quickest way to see what the runtime stored. Change state through the API rather than editing files.

## 5. Iterate without rebuilding

For Actors with a slow build (browser images, heavy Python installs), a four second rebuild is
optimistic. The runtime can instead bind-mount your local source folder over the built image's working
directory, so a run picks up local edits without `apify push`.

Register the folder once per Actor, with an absolute host path:

```bash
ACTOR_ID=$(apify push --json | jq -r .actor.id)   # or read it off the push output
apify api POST /actor-runtime/dev-folder/$ACTOR_ID --body "\"$PWD\""
```

Then the loop shrinks to:

```bash
# edit src/main.ts, then recompile locally
npm run build
apify call --input '{"maxPages": 3}'
```

How it behaves:

- The mount covers the image's working directory, but `node_modules` from the built image stays
  available underneath, so only source edits skip the rebuild. A dependency change, a Dockerfile
  change, or a `requirements.txt` change still needs a real `apify push`.
- Node does not reload a running process. A recompile is picked up by the next run's container, not
  by a run already in progress.
- The runtime verifies the path exists on the host and is a directory when you register it, and a run
  fails visibly if the folder later disappears rather than mounting an empty directory.
- The same form lives on the Actor's page in the console, if you prefer clicking.
- Clear the registration with an empty body: `--body '""'`.

The runtime can only do this for a host path you give it: the CLI does not tell it where your source
lives, and the runtime itself runs in a container. See [Ideal state](#ideal-state) for how that step
could disappear.

## 6. Debug with your IDE

Turn debug mode on for an Actor once, and every run of it starts paused, waiting for a debugger:

```bash
apify api POST /actor-runtime/debug/<actorId> --body '{"enabled": true}'
apify call --timeout 900
```

The run's log prints one line with the detected language, the debug tool, the address to attach to,
and which IDE action to use: VS Code's **Attach** for Node (port `9229`), PyCharm's **Attach to DAP** or
VS Code's **Python: Remote Attach** for Python (port `5678`). The port is published on `127.0.0.1`
only. Connect, and the Actor runs to your first breakpoint; the runtime sets none of its own.

Override detection or the port when needed, and clear the toggle to run normally again:

```bash
apify api POST /actor-runtime/debug/<actorId> --body '{"enabled": true, "language": "node", "port": 9230}'
apify api POST /actor-runtime/debug/<actorId> --body '{"enabled": false}'
```

Two things to know:

- The run's timeout is not extended while it waits for you. Pass a generous `--timeout`.
- The image's `CMD` must start the interpreter directly. `npm start` is refused, because the debugger
  would attach to npm, not your Actor. A Node Actor pushed without its own Dockerfile hits this, since
  the injected default uses `npm start`. Give it a Dockerfile ending in
  `CMD ["node", "dist/main.js"]`, like the TypeScript sample.

## 7. Rehearse platform behaviour

The platform stops, moves, and aborts Actors. The runtime lets you trigger those on demand against a
`RUNNING` run to check that your Actor persists state and resumes correctly.

| Event          | How to trigger                                                                                       | What the Actor sees                                                                                                                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Migration      | `apify api POST /actor-runtime/migrate/<runId>`, or the **Migrate** button on the run's console page | A `migrating` event, then its container is stopped about five seconds later and a fresh container starts for the same run: same run id, env vars, and storages, in-memory state gone. Status stays `RUNNING`; `stats.migrationCount` increments. |
| Reboot         | `apify api POST v2/actor-runs/<runId>/reboot`                                                        | Immediate stop and restart, no warning event. This is what the SDKs call from their default migration handler.                                                                                                                                   |
| Graceful abort | `apify api POST 'v2/actor-runs/<runId>/abort?gracefully=true'`                                       | `aborting` and `persistState` events, then the container is stopped 30 seconds later.                                                                                                                                                            |
| Hard abort     | `apify api POST v2/actor-runs/<runId>/abort`                                                         | Container stopped at once.                                                                                                                                                                                                                       |
| Timeout        | `apify call --timeout 10`                                                                            | Run ends `TIMED-OUT` when the deadline passes. The budget is per run, so a migrated run gets only what is left.                                                                                                                                  |

The run log is cumulative across restarts with a marker line between incarnations, so you can read
the whole story in one place.

## 8. Simulate several users

Each distinct token gets its own user, and API responses are scoped to that user's objects. Pass a
different bearer token to act as someone else:

```bash
apify api v2/datasets -H '{"authorization": "Bearer another-token"}'
```

The console has no login and shows every user's objects with their owner, which is useful for checking
that scoping worked.

## 9. Fall back to the real platform

If a call fails because the runtime does not have that Actor, run, or storage id, or does not implement
that endpoint, you can have such calls relayed to the real platform instead:

```bash
apify api POST /actor-runtime/api-fallback --body '{"fallbackUnimplementedEnabled": true, "fallbackNotFoundEnabled": true}'
apify api GET  /actor-runtime/api-fallback
```

Both toggles default to off and reset on every restart. When on, the runtime forwards the token you
authenticated with, for every HTTP method, so a locally missing `POST` or `DELETE` becomes a real write
against your real account. Turn this on only with a token and account you are comfortable using that
way. Relayed responses carry `x-actor-runtime-fallback` and `x-actor-runtime-fallback-trigger` headers
so you can tell where an answer came from. The same toggles are on the console's Settings page.

## 10. Go back to the platform

The runtime never touches your CLI credentials. Unset the two variables and the same commands target
the real platform again:

```bash
unset APIFY_CLIENT_BASE_URL APIFY_CONSOLE_URL
apify push
```

## Limitations

The runtime is a development tool sized for a single developer: fewer than ten Actors, five concurrent
runs, and about a hundred of each storage type. It is not a place to host Actors. Known differences
from the platform:

- **Not implemented:** Actor tasks, schedules, webhooks, and most of the API outside Actors, builds,
  runs, logs, and the three storage types. Unknown endpoints return `404` unless fallback (section 9)
  is on.
- **Request queues:** no lock expiry (`head/lock` hands requests out until an explicit unlock, reclaim,
  or runtime restart), request deletion returns `501`, `GET /requests` lists only requests this runtime
  process has seen and ignores filters. Counts on the queue object are authoritative.
- **Storage metadata:** `hadMultipleClients` is always `false`, `stats` fields are zero, and dataset
  item options like `fields` or `clean` apply after paging so `total` counts unfiltered items.
- **Users:** any non-empty token is accepted. There is no real authentication, and the console shows
  every user's objects.
- **One runtime per data directory.** Do not start two runtimes on the same `./data`.
- **Operating systems:** Linux is tested. macOS works with the networking note in the quick start.
  Windows with Docker Desktop and WSL 2 is untested.

## Ideal state

> **Proposal.** The items below are not implemented. They describe the developer experience this
> project is working towards, ordered roughly by how much friction they remove.

1. **`apify local` as the only tool.** Start, stop, status, env, reset, and logs commands in the
   stable Apify CLI, with a published, versioned image and networking that works on every host.
   Details in the [quick start's ideal-state section](quick-start.md#ideal-state-apify-local).
2. **No dev-folder registration.** Today section 5 needs an absolute host path per Actor. Two ways to
   remove the step, either of which is non-breaking:
    - The CLI includes the Actor's local folder when pushing to a local runtime, and the runtime
      registers it. Cleanest, but a CLI change.
    - The runtime is started with a projects root mounted (`-v ~/Projects:/dev-root`), and on each
      push it finds the folder whose files match the uploaded source, translates the path back to the
      host, and registers it itself. No CLI change.
3. **A dev flag on `call`.** Something like `apify call --dev` that recompiles locally, ensures the dev
   folder is registered, and runs, so the loop in section 5 is one command.
4. **Runtime-side fix for Docker Desktop networking.** The runtime's own network attach should set
   gateway priority so the bridge network stays the default route, removing the quick start workaround.
5. **Housekeeping.** `apify local reset` for data, and pruning of superseded build images so a long
   session does not fill the disk.
6. **Accept Actor names where ids are required.** The `/actor-runtime/*` endpoints take an Actor id;
   accepting the name from `.actor/actor.json` saves a lookup.
