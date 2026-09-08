# Quick start

Learn how to build, run, and inspect [Actors](https://docs.apify.com/actors) on your own machine with the local Actor runtime.

The local Actor runtime is a single Docker container that emulates the parts of the Apify platform the Actor development loop needs. You use the same Apify CLI commands as against the platform, but builds and runs happen on your computer and no platform compute is used.

## Before you start

- [Install Docker](https://docs.docker.com/get-docker/). Use Docker Desktop on macOS or Windows, or Docker Engine on Linux. Docker must be running.
- [Install Apify CLI](https://docs.apify.com/cli/docs/installation).
- Log in with `apify login`. You do not need a real Apify account: the runtime accepts any non-empty token and maps it to a local user. With a real token, the runtime adopts your username, id, and proxy password the first time it sees it.

## 1. Start the runtime

Choose one of the following methods.

### Start with Apify CLI

In your Actor directory, run:

```
apify local start --detach --data-dir ./data
```

The command checks that Docker works, downloads the runtime image, and starts it. Runtime data is stored in the `data` directory of your Actor, so each Actor has its own local platform state.

To stop the runtime later, run `apify local stop`.

**In development**

These commands are still in development, and the image they download comes from a temporary developer repository.

### Start with Docker

Build the image from this repository and run it:

```
docker build -t actor-runtime .
docker run --rm --name actor-runtime \
  -p 3333:3333 -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$(pwd)/data:/data" \
  actor-runtime
```

The runtime needs two mounts:

| Mount                                       | Purpose                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `/var/run/docker.sock:/var/run/docker.sock` | Lets the runtime build and run Actor containers on your Docker.    |
| `$(pwd)/data:/data`                         | Keeps Actors, builds, runs, and storages across restarts as files. |

Add `-d` to run the container in the background. Stop it with `docker stop actor-runtime`.

**Docker Desktop on macOS**

On some Docker Desktop installations, requests to the runtime's ports time out even though the runtime is healthy. The runtime joins a second Docker network, `apify-local`, so Actor containers can reach it, and Docker Desktop then routes replies through the wrong network. Start the container on that network directly so it has only one:

```
docker network create apify-local 2>/dev/null || true
docker run --rm --name actor-runtime \
  --network apify-local --network-alias apify-api \
  -p 3333:3333 -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$(pwd)/data:/data" \
  actor-runtime
```

The startup warning that the runtime could not attach to the network is expected in this setup. `apify local start` does not have this option yet.

### Check that it is running

To verify that the runtime is up, run:

```
apify local status
```

The command reports the runtime API URL, `http://localhost:3333`, and the data directory, and exits non-zero when the runtime is down.

**Proposed command**

`apify local status` does not exist yet. Until it ships, run this instead:

```
APIFY_CLIENT_BASE_URL=http://localhost:3333 apify api v2/users/me
```

It prints your user as JSON when the runtime is up, and a connection error when it is not.

## 2. Connect Apify CLI

To send every Apify CLI command to the local runtime instead of the Apify platform, run:

```
apify local connect
```

Your login is not affected. To switch back to the Apify platform, run:

```
apify local disconnect
```

**Proposed commands**

`apify local connect` and `apify local disconnect` do not exist yet. Until they ship, Apify CLI reads the target URLs from two environment variables. Set them in the terminal you develop in:

```
export APIFY_CLIENT_BASE_URL=http://localhost:3333
export APIFY_CONSOLE_URL=http://localhost:3000
```

Unset both variables to switch back to the Apify platform.

## 3. Push and run your Actor

1. Navigate to your Actor directory:

    ```
    cd your-actor-name
    ```

2. Push the Actor to the runtime:

    ```
    apify push
    ```

    The CLI uploads the source code, creates the Actor in the runtime, and shows the build log. The first build downloads the base image and installs dependencies, so it takes about a minute. Later builds reuse Docker's layer cache and take seconds.

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

`apify api` sends any request to the runtime API, so every Actor, build, run, log, and storage is available this way. The raw files are in the `data` directory. Read them freely, but change state through the API.

## 5. Stop and reset the runtime

- To stop, run `apify local stop` or `docker stop actor-runtime`.
- To keep your data, start the runtime again with the same `data` directory.
- To reset, stop the runtime and delete the `data` directory. Built Actor images stay in Docker and are reused when you push the same source again.

## 6. Debug your Actor with your IDE

To make every run of your Actor pause at start and wait for a debugger, turn on debug mode once. The Actor id is in the output of `apify push`:

```
ACTOR_ID=<your Actor id>
apify api POST /actor-runtime/debug/$ACTOR_ID --body '{"enabled": true}'
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
apify api POST /actor-runtime/debug/$ACTOR_ID --body '{"enabled": true, "language": "node", "port": 9230}'
apify api POST /actor-runtime/debug/$ACTOR_ID --body '{"enabled": false}'
```

**Before you debug**

- The run timeout is not extended while the run waits for you. Pass a generous `--timeout`.
- The image's `CMD` must start the interpreter directly. `npm start` is refused because the debugger would attach to npm, not to your Actor. A Node.js Actor pushed without its own Dockerfile hits this, since the default Dockerfile uses `npm start`. Add a Dockerfile ending with `CMD ["node", "dist/main.js"]`, like the TypeScript sample.

## Next steps

- See `requirements/*.md` in this repository for the exact behaviour of the API, storages, and Actor driver.
