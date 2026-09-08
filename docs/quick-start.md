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

The `apify runtime` commands ship on the `runtime` npm tag while they are in development. They check that Docker works, download the runtime image, and start it.

```
npm install -g apify-cli@runtime
apify runtime start --detach --data-dir ./data
```

To stop the runtime later, run `apify runtime stop`.

**Opt-in channel**

The stable `apify-cli` does not have these commands yet, and the image they download comes from a temporary developer repository. See [Proposed: `apify local`](#proposed-apify-local) for the intended final form.

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

On some Docker Desktop installations, `localhost:3333` and `localhost:3000` time out even though the runtime is healthy. The runtime joins a second Docker network, `apify-local`, so Actor containers can reach it, and Docker Desktop then routes replies through the wrong network. Start the container on that network directly so it has only one:

```
docker network create apify-local 2>/dev/null || true
docker run --rm --name actor-runtime \
  --network apify-local --network-alias apify-api \
  -p 3333:3333 -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$(pwd)/data:/data" \
  actor-runtime
```

The startup warning that the runtime could not attach to the network is expected in this setup. `apify runtime start` does not have this option yet.

### Check that it is running

The runtime prints a banner with both ports when it is ready:

| Component | URL                     |
| --------- | ----------------------- |
| API       | `http://localhost:3333` |
| Console   | `http://localhost:3000` |

Open the Console in your browser. If the banner warns that the Docker socket is unreachable, storages and records still work, but builds and runs fail with a clear message.

## 2. Connect Apify CLI

Apify CLI sends requests to the URLs in two environment variables. Set them in the terminal you develop in:

```
export APIFY_CLIENT_BASE_URL=http://localhost:3333
export APIFY_CONSOLE_URL=http://localhost:3000
```

To verify, run:

```
apify info
```

The CLI prints the user the runtime created for your token, for example `local-user-1`.

**Switch back to the Apify platform**

Unset both variables to make the CLI talk to the Apify platform again. Your login is not affected.

## 3. Push and run an Actor

You can use one of the sample Actors in this repository or your own Actor project.

1. Navigate to the Actor directory:

    ```
    cd sample_actor_ts
    ```

2. Push the Actor to the runtime:

    ```
    apify push
    ```

    The CLI uploads the source code, creates the Actor, and shows the build log. The first build downloads the base image and installs dependencies, so it takes about a minute. Later builds reuse Docker's layer cache and take seconds.

3. Run the Actor:

    ```
    apify call --input '{"maxPages": 3}'
    ```

    The CLI streams the run log and prints the run's default storage ids when it finishes. Add `--json` to get them as JSON.

## 4. View the results

Open [http://localhost:3000](http://localhost:3000) to browse the Actor, its builds and runs, logs, and the dataset, key-value store, and request queue the run produced.

You can also use the CLI:

| Command                                                  | Shows                                   |
| -------------------------------------------------------- | --------------------------------------- |
| `apify runs ls`                                          | Runs of the Actor in the current folder |
| `apify datasets info <datasetId>`                        | Dataset metadata, including item count  |
| `apify api v2/datasets/<datasetId>/items`                | Dataset items                           |
| `apify api v2/key-value-stores/<storeId>/records/OUTPUT` | One key-value store record              |
| `apify api v2/actor-runs/<runId>/log`                    | The run log                             |

`apify api` sends any request to the runtime API, so everything the Console shows is available this way. The raw files are in the `data` directory. Read them freely, but change state through the API.

## 5. Stop and reset the runtime

- To stop, run `apify runtime stop` or `docker stop actor-runtime`.
- To keep your data, start the runtime again with the same `data` directory.
- To reset, stop the runtime and delete the `data` directory. Built Actor images stay in Docker and are reused when you push the same source again.

## Next steps

- Learn the full development loop in [Local development workflow](local-development.md), including iterating without rebuilds, debugging with your IDE, and testing migrations.
- See `requirements/*.md` in this repository for the exact behaviour of the API, console, storages, and Actor driver.

## Proposed: `apify local`

**Proposal**

Nothing in this section exists yet. It describes the intended developer experience so the gap is visible and can be closed step by step without breaking what works today.

The goal is that Apify CLI is the only tool you need, in the same way `supabase start` gives you a whole local stack:

```
npm install -g apify-cli
apify local start
apify push && apify call
apify local stop
```

| Command                                     | What it does                                                                                                                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apify local start [--detach] [--data-dir]` | Checks Docker, downloads the runtime image from an Apify-owned registry if needed, starts it with the right flags for your host, and prints how to connect. Data defaults to `~/.apify/actor-runtime/data`. |
| `apify local stop`                          | Stops the runtime.                                                                                                                                                                                          |
| `apify local status`                        | Shows whether the runtime is running, its ports, data directory, image version, and running Actor containers. Exits non-zero when it is down.                                                               |
| `apify local env`                           | Prints the `export` lines for `APIFY_CLIENT_BASE_URL` and `APIFY_CONSOLE_URL`, so `eval "$(apify local env)"` connects your shell.                                                                          |
| `apify local reset`                         | Stops the runtime and clears its data directory after confirmation.                                                                                                                                         |
| `apify local logs [-f]`                     | Shows the runtime's own log.                                                                                                                                                                                |

The commands also fix the Docker Desktop networking issue described in step 1, use a versioned image under Apify's own registry namespace, and ship in the stable `apify-cli` instead of an opt-in tag.

**Why `local` instead of `runtime`**

The `apify runtime` commands are the first step of this plan. They are on the `runtime` npm tag today, and their spec is in `requirements/distribution.md` on the `claude/actor-runtime-cli-distribution-mo0u94` branch. The proposal is to graduate them under the name `local` when they reach the stable CLI, because it names what you get, a local platform, rather than the repository that implements it. Until that is decided, `apify runtime` is the working CLI path.
