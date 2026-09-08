# Local development workflow

Learn how to develop, debug, and test [Actors](https://docs.apify.com/actors) against the local Actor runtime.

The development loop is the same as against the Apify platform: edit the source, push, run, and inspect the results. The runtime adds a few local-only controls on top, such as running edited source without a rebuild, attaching an IDE debugger, and triggering platform events like migrations on demand.

## Before you start

- [Start the runtime and connect Apify CLI](quick-start.md). The commands below assume Apify CLI is connected to the runtime.
- Have your Actor project ready and run the commands below from its directory. If you do not have one, use `sample_actor_ts`, `sample_actor_py`, or `sample_actor_crawler` from this repository.

## Build the Actor

To upload the source code and build the Actor, run:

```
apify push
```

Add `--json` to print the Actor id and build id, which the local-only endpoints below need.

The runtime builds the image on your Docker daemon, not inside its own container, so Docker's layer cache is reused across builds and runtime restarts. Times measured on the TypeScript sample:

| Situation                                | Build time |
| ---------------------------------------- | ---------- |
| First build (base image, `npm install`)  | About 30 s |
| Push again with no source change         | Under 1 s  |
| Push again after editing one source file | About 4 s  |

### Dockerfile resolution

The runtime resolves the Dockerfile from the pushed source in this order and states the outcome in the build log:

1. The `dockerfile` field of `.actor/actor.json`, relative to `.actor/`.
2. `.actor/Dockerfile`.
3. `Dockerfile` in the Actor root.
4. The platform's default Dockerfile, injected for that build only.

An Actor without a Dockerfile still builds. Note that the default Dockerfile inherits `CMD ["npm", "start", "--silent"]` from its base image, which matters for [debugging](#debug-with-your-ide).

### Inspect or abort a build

| Command                                          | What it does                        |
| ------------------------------------------------ | ----------------------------------- |
| `apify api v2/actor-builds/<buildId>`            | Shows status and timings.           |
| `apify api v2/actor-builds/<buildId>/log`        | Shows the full build log.           |
| `apify api POST v2/actor-builds/<buildId>/abort` | Cancels the in-flight Docker build. |

Builds time out after 30 minutes. A successful build becomes the Actor's `latest` build, which `apify call` runs by default. Each push creates a new build record and image tag, so run `docker image prune` occasionally if disk space matters.

## Run the Actor

To start a run and stream its log, run:

```
apify call --input '{"maxPages": 3}'
```

Common options:

| Option                    | Effect                                               |
| ------------------------- | ---------------------------------------------------- |
| `--input-file input.json` | Reads the input from a file.                         |
| `--timeout 600`           | Sets the run timeout in seconds. The default is 300. |
| `--memory 2048`           | Sets the memory limit in MB.                         |
| `--json`                  | Prints the run id and default storage ids as JSON.   |

The Actor runs as a container on your Docker daemon, on a dedicated `apify-local` network where the runtime API is reachable as `http://apify-api:3333`. The container receives the same environment variables the platform sets, so the Apify SDKs work unchanged: `APIFY_TOKEN`, `APIFY_API_BASE_URL`, the default storage ids, `ACTOR_ID` and `ACTOR_RUN_ID`, memory and CPU hints, the events websocket URL, and `APIFY_IS_AT_HOME=1`. Environment variables defined on the Actor version are applied too, but platform-owned variables take precedence.

**Apify Proxy**

To use Apify Proxy from local runs, set `APIFY_PROXY_PASSWORD` on the runtime container, for example `docker run -e APIFY_PROXY_PASSWORD=... `. If you logged in with a real token and the platform was reachable at first contact, the runtime already knows your proxy password and forwards it. Otherwise the variable is absent in Actor containers.

## View the results

Everything a run produced is available in two places.

### CLI

| Command                                                  | Shows                     |
| -------------------------------------------------------- | ------------------------- |
| `apify runs ls`                                          | Runs of the current Actor |
| `apify datasets info <datasetId>`                        | Dataset metadata          |
| `apify api v2/actor-runs/<runId>`                        | The run object            |
| `apify api v2/actor-runs/<runId>/log`                    | The run log               |
| `apify api v2/datasets/<datasetId>/items`                | Dataset items             |
| `apify api v2/key-value-stores/<storeId>/keys`           | Key-value store keys      |
| `apify api v2/key-value-stores/<storeId>/records/OUTPUT` | One record                |
| `apify api v2/request-queues/<queueId>`                  | Request queue counts      |

The run object also exposes its default storages under aliases such as `v2/actor-runs/<runId>/dataset/items`. The runtime uses `v2/actors`, not the platform's `v2/acts` alias.

### Files

The `data` directory mounted into the runtime holds every storage, build record, run record, and log as files. Reading it is the quickest way to see what the runtime stored. Change state through the API rather than by editing the files.

## Iterate without rebuilding

For Actors with a slow build, such as browser images or heavy Python installs, the runtime can bind-mount your local source directory over the built image's working directory. A run then picks up local edits without `apify push`.

1. Register the source directory once per Actor, with an absolute path on your host:

    ```
    ACTOR_ID=$(apify push --json | jq -r .actor.id)
    apify api POST /actor-runtime/dev-folder/$ACTOR_ID --body "\"$PWD\""
    ```

2. Edit the source and recompile locally, for example `npm run build` for TypeScript.

3. Run the Actor:

    ```
    apify call --input '{"maxPages": 3}'
    ```

To clear the registration, submit an empty body: `--body '""'`.

**How the mount behaves**

- The mount covers the working directory, but `node_modules` from the built image stays available underneath. Only source edits skip the rebuild. Dependency, Dockerfile, and `requirements.txt` changes still need `apify push`.
- A running process does not reload. A recompile is picked up by the next run's container.
- The runtime checks that the path exists on your host and is a directory when you register it. If the directory later disappears, the run fails visibly instead of mounting an empty directory.
- The runtime can only mount a path you give it. Apify CLI does not tell it where your source lives, and the runtime itself runs in a container. See [Proposed improvements](#proposed-improvements).

## Debug with your IDE

To make every run of an Actor pause at start and wait for a debugger, turn on debug mode once:

```
apify api POST /actor-runtime/debug/<actorId> --body '{"enabled": true}'
apify call --timeout 900
```

The run log prints one line with the detected language, the debug tool, the address to attach to, and the IDE action to use:

| Language | Default port | Attach with                                                    |
| -------- | ------------ | -------------------------------------------------------------- |
| Node.js  | `9229`       | VS Code **Attach**                                             |
| Python   | `5678`       | PyCharm **Attach to DAP** or VS Code **Python: Remote Attach** |

The port is published on `127.0.0.1` only. After you attach, the Actor runs to your first breakpoint. The runtime sets no breakpoints of its own.

To override the detected language or the port, or to turn debug mode off:

```
apify api POST /actor-runtime/debug/<actorId> --body '{"enabled": true, "language": "node", "port": 9230}'
apify api POST /actor-runtime/debug/<actorId> --body '{"enabled": false}'
```

**Before you debug**

- The run timeout is not extended while the run waits for you. Pass a generous `--timeout`.
- The image's `CMD` must start the interpreter directly. `npm start` is refused because the debugger would attach to npm, not to your Actor. A Node.js Actor pushed without its own Dockerfile hits this, since the default Dockerfile uses `npm start`. Add a Dockerfile ending with `CMD ["node", "dist/main.js"]`, like the TypeScript sample.

## Test platform events

The platform stops, migrates, and aborts Actors. You can trigger these events against a `RUNNING` run to check that your Actor persists its state and resumes correctly.

| Event          | How to trigger                                                 | What the Actor sees                                                                                                                                                                                                  |
| -------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration      | `apify api POST /actor-runtime/migrate/<runId>`                | A `migrating` event, then its container stops about five seconds later and a new container starts for the same run with the same id, environment, and storages. In-memory state is gone. The status stays `RUNNING`. |
| Reboot         | `apify api POST v2/actor-runs/<runId>/reboot`                  | An immediate stop and restart with no warning event. The SDKs call this from their default migration handler.                                                                                                        |
| Graceful abort | `apify api POST 'v2/actor-runs/<runId>/abort?gracefully=true'` | `aborting` and `persistState` events, then the container stops 30 seconds later.                                                                                                                                     |
| Abort          | `apify api POST v2/actor-runs/<runId>/abort`                   | The container stops at once.                                                                                                                                                                                         |
| Timeout        | `apify call --timeout 10`                                      | The run ends as `TIMED-OUT` when the deadline passes. The budget is per run, so a migrated run gets only the remaining time.                                                                                         |

The run log is cumulative across restarts, with a marker line between container incarnations.

## Simulate multiple users

Each distinct token gets its own user, and API responses are scoped to that user's objects. To act as another user, pass a different token:

```
apify api v2/datasets -H '{"authorization": "Bearer another-token"}'
```

## Fall back to the Apify platform

If a call fails because the runtime does not have that Actor, run, or storage id, or does not implement the endpoint, you can have such calls relayed to the Apify platform:

```
apify api POST /actor-runtime/api-fallback --body '{"fallbackUnimplementedEnabled": true, "fallbackNotFoundEnabled": true}'
apify api GET /actor-runtime/api-fallback
```

Both toggles are off by default and reset on every restart. Relayed responses carry the `x-actor-runtime-fallback` and `x-actor-runtime-fallback-trigger` headers so you can tell where an answer came from.

**Use a token you trust with real writes**

When fallback is on, the runtime forwards the token you authenticated with, for every HTTP method. A locally missing `POST` or `DELETE` becomes a real write against your real account.

## Return to the Apify platform

The runtime never changes your CLI credentials. To target the platform again, disconnect the CLI as described in the [quick start](quick-start.md#2-connect-apify-cli), then push:

```
apify push
```

## Limitations

The runtime is a development tool for one developer: fewer than ten Actors, five concurrent runs, and about a hundred of each storage type. It is not for hosting Actors. Known differences from the platform:

- **Not implemented:** Actor tasks, schedules, webhooks, and most of the API outside Actors, builds, runs, logs, and the three storage types. Unknown endpoints return `404` unless [fallback](#fall-back-to-the-apify-platform) is on.
- **Request queues:** locks do not expire, so `head/lock` hands a request out until an explicit unlock, reclaim, or runtime restart. Request deletion returns `501`. `GET /requests` lists only requests this runtime process has seen and ignores filters. Counts on the queue object are authoritative.
- **Storage metadata:** `hadMultipleClients` is always `false`, `stats` fields are zero, and dataset item options such as `fields` or `clean` apply after paging, so `total` counts unfiltered items.
- **Users:** any non-empty token is accepted. There is no real authentication.
- **One runtime per data directory.** Do not start two runtimes on the same `data` directory.
- **Operating systems:** Linux is tested. macOS works with the networking note in the [quick start](quick-start.md#start-with-docker). Windows with Docker Desktop and WSL 2 is untested.

## Next steps

- Read the exact behaviour in `requirements/api.md`, `requirements/actor-driver.md`, and `requirements/storage.md`.
- When your Actor works locally, unset the environment variables and `apify push` to deploy it to the Apify platform.

## Proposed improvements

**Proposal**

The items below are not implemented. They describe the developer experience this project is working towards, ordered by how much friction they remove.

1. **`apify local` as the only tool.** `start`, `stop`, `status`, `connect`, `disconnect`, `reset`, and `logs` commands in the stable Apify CLI, with a published, versioned image and networking that works on every host.
2. **No dev-folder registration.** Today [Iterate without rebuilding](#iterate-without-rebuilding) needs an absolute host path per Actor. Two ways to remove the step, both non-breaking:
    - Apify CLI includes the Actor's local directory when pushing to a local runtime, and the runtime registers it. This needs a CLI change.
    - The runtime is started with a projects root mounted, for example `-v ~/Projects:/dev-root`, and on each push it finds the directory whose files match the uploaded source, translates the path back to the host, and registers it itself. No CLI change.
3. **A dev flag on `call`.** Something like `apify call --dev` that recompiles locally, ensures the dev folder is registered, and runs, so the iteration loop is one command.
4. **Runtime-side fix for Docker Desktop networking.** The runtime's network attach should set the gateway priority so the bridge network stays the default route, which removes the workaround in the quick start.
5. **Housekeeping.** `apify local reset` for data, and pruning of superseded build images so a long session does not fill the disk.
6. **Accept Actor names where ids are required.** The `/actor-runtime/*` endpoints take an Actor id. Accepting the name from `.actor/actor.json` saves a lookup.
