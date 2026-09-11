# Quick start

Learn how to build, run, and debug [Actors](https://docs.apify.com/actors) on your own machine with the local Actor runtime.

The local Actor runtime is a single container that emulates the parts of the Apify platform the Actor development loop needs. You use the same Apify CLI commands as against the platform, but builds and runs happen on your computer and no platform compute is used.

## Before you start

- Install a container engine and make sure it is running: [Docker](https://docs.docker.com/get-started/get-docker/) (Docker Desktop on macOS and Windows, Docker Engine on Linux) or [Podman](https://podman.io/docs/installation) 3.4 or newer, whose API socket must be served. The first one found on your `PATH` is used, Docker before Podman; set `APIFY_CONTAINER_ENGINE=docker` or `=podman` to choose.
- [Install Apify CLI](https://docs.apify.com/cli/docs/installation).
- Log in with `apify login`. You do not need a real Apify account: the runtime accepts any non-empty token and maps it to a local user. With a real token, the runtime adopts your username, id, and proxy password the first time it sees it.

## 1. Start the runtime

Choose one of the following methods.

### Start with Apify CLI

Run:

```
apify runtime start --detach
```

The command checks that your container engine works, downloads the runtime image if it is missing, and starts the runtime in the background. Without `--detach` it stays in the foreground and Ctrl+C stops it.

Runtime data - storages, builds, and run records - is stored in `~/.apify/actor-runtime/data`, shared by every Actor you work on. Pass `--data-dir ./data` to keep one Actor's local platform state in its own directory instead.

To download the image ahead of time, or to run an image other than the default `apify/actor-runtime:latest`, use `apify runtime install [image]` first; `apify runtime start` then runs the image installed last.

To stop the runtime later, run `apify runtime stop`.

### Start with Docker

Build the image from this repository and run it:

```
docker build -t actor-runtime .
mkdir -p data
docker run --rm --init --name apify-actor-runtime \
  -p 3333:3333 -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$(pwd)/data:/data" \
  actor-runtime
```

Podman serves the same Docker-compatible API, so it works the same way - mount its socket where the runtime expects Docker's (`/run/podman/podman.sock` rootful, `$XDG_RUNTIME_DIR/podman/podman.sock` rootless). See the [README](../README.md#running-with-podman-instead-of-docker) for the details.

### Check that it is running

To see what the runtime is doing, run:

```
apify runtime status
```

It reports whether the runtime is running, on which engine and image, which ports it publishes, and the host directory it keeps its data in:

```
Actor runtime: running on docker (container 'apify-actor-runtime')

  Image:            apify/actor-runtime:latest
  Data directory:   /home/you/.apify/actor-runtime/data

Published ports:
  3000/tcp   -> 0.0.0.0:3000  (Console)
  3333/tcp   -> 0.0.0.0:3333  (API)

Apify CLI target:
  the Actor runtime (apify runtime connect)
  API base URL:     http://localhost:3333
```

The command exits with code 1 when the runtime is not running, so a script can test for it. Add `--json` to read the same information as JSON.

## 2. Connect Apify CLI

To send every Apify CLI command to the local runtime instead of the Apify platform, run:

```
apify runtime connect
```

The connection is remembered across terminals until you revert it, and your login is not affected. To switch back to the Apify platform, run:

```
apify runtime disconnect
```

**Pointing the CLI at the runtime for one shell or one command**

Apify CLI, and the Apify SDKs and API clients that honour them, also read the target URLs from two environment variables:

```
export APIFY_CLIENT_BASE_URL=http://localhost:3333
export APIFY_CONSOLE_URL=http://localhost:3000
```

They take precedence over `apify runtime connect` wherever they are set, so you can point a single shell - or a single command, `APIFY_CLIENT_BASE_URL=http://localhost:3333 apify actors ls` - at the runtime while the rest of your terminals stay on the platform. Unset them to let the connection decide again. `apify runtime status` prints the ones it finds set.

## 3. Push and run your Actor

1. Navigate to your Actor directory:

    ```
    cd your-actor-name
    ```

2. Push the Actor to the runtime:

    ```
    apify push
    ```

    The CLI uploads the source code, creates the Actor in the runtime, and shows the build log. The first build downloads the base image and installs dependencies, so it takes about a minute. Later builds reuse the engine's layer cache and take seconds.

    Pointed at the runtime, `apify push` also registers the pushed directory as the Actor's live dev folder, which is what makes step 5 work.

3. Run the Actor:

    ```
    apify call
    ```

    The run uses the input from your local `storage/key_value_stores/default/INPUT.json`. To pass a different input, add `--input '{"key": "value"}'` or `--input-file input.json`. The CLI streams the run log and prints the run's default storage ids when it finishes. Add `--json` to get them as JSON.

**No Actor yet?**

Create one with [`apify create`](https://docs.apify.com/cli/docs/quick-start), or use `sample_actor_ts` in this repository, which takes `--input '{"maxPages": 3}'`.

## 4. View the results

To list the runs of your Actor, run:

```
apify runs ls
```

To read what a run produced, use the ids `apify call` printed:

| Command                                                  | Shows                                  |
| -------------------------------------------------------- | -------------------------------------- |
| `apify datasets info <datasetId>`                        | Dataset metadata, including item count |
| `apify api v2/datasets/<datasetId>/items`                | Dataset items                          |
| `apify api v2/key-value-stores/<storeId>/records/OUTPUT` | One key-value store record             |
| `apify api v2/actor-runs/<runId>/log`                    | The run log                            |

`apify api` sends any request to the runtime API, so every Actor, build, run, log, and storage is available this way. The raw files are in the runtime's data directory, the one `apify runtime status` prints. Read them freely, but change state through the API.

The runtime also serves a console at `http://localhost:3000` - the same Actors, builds, runs, and storages in a browser. `apify runtime connect` points the CLI's console links at it too.

## 5. Edit your Actor's code

Edit the code of your Actor and see the results without rebuilding it.

1. Change the source in your Actor directory, for example `src/main.ts`.

2. Compile the code, if your language needs it:

    ```
    npm run build
    ```

3. Run the Actor again:

    ```
    apify call
    ```

The run starts from your edited source. There is no `apify push` and no build in between, so the loop takes seconds instead of the minute a build costs.

This works because `apify push` registered your Actor directory as its dev folder, and every run mounts that folder over the built image. Edits apply to the next run you start, not to a run already in progress. Changes to dependencies, such as `package.json` or `requirements.txt`, still need `apify push`, because dependencies are installed during the build. To run once from the built image alone, without touching the registration, use `apify call --no-dev-folder`.

## 6. Debug a run in your IDE

Turn debug mode on for an Actor once, and every run of it starts paused, waiting for a debugger to attach - with no change to the Actor's own source, Dockerfile, or `requirements.txt`:

```
apify api POST /actor-runtime/debug/<actorId> --body '{"enabled": true}'
apify call
```

`<actorId>` is the id `apify push --json` printed (`.actor.id`). The run's log prints the address to attach to and the action to use: VS Code's **Attach** for Node (port `9229`), PyCharm's **Attach to DAP** or VS Code's **Python: Remote Attach** for Python (port `5678`). Connect, and execution proceeds to your own first breakpoint.

Add `"language": "node"` or `"python"` if the image cannot be classified automatically, and `"port": <n>` to override the default. Turn it off with `--body '{"enabled": false}'`.

Two things to know: the run's own `timeoutSecs` is not extended while it waits for you, so pass a larger `apify call --timeout` when you expect a slow attach; and an Actor whose image runs through `npm start` is refused, because the debugger would attach to npm rather than your Actor. **This includes any Node Actor pushed without a `Dockerfile` of its own.** Give such an Actor a `Dockerfile` whose `CMD` invokes `node` directly, for example `CMD ["node", "dist/main.js"]`.

To watch a Playwright or Puppeteer Actor's browser while it runs, turn browser view on for it the same way:

```
apify api POST /actor-runtime/browser-view/<actorId> --body '{"enabled": true}'
```

Every run then prints a viewer URL, `http://localhost:3000/runs/<runId>/browser`. Add `"interactive": true` to also send your mouse and keyboard to the display. The browser has to run headful to show anything - Apify's templates default to headless, which shows as a black display.

## 7. Stop and reset the runtime

- To stop, run `apify runtime stop` (or `docker stop apify-actor-runtime`).
- To keep your data, start the runtime again with the same data directory.
- To reset, stop the runtime and delete that directory - `apify runtime status` prints where it is. Built Actor images stay in your container engine and are reused when you push the same source again.
- Run `apify runtime disconnect` to point Apify CLI back at the Apify platform. It is independent of stopping the runtime: a connected CLI with no runtime running just fails to reach it.
