# Quick start

`actor-runtime` is a local Apify platform in a single Docker container. It emulates the parts of the
Apify API and Console that the Actor development loop needs, so you can `apify push`, build, run, and
inspect an Actor entirely on your machine, without waiting for a platform build or paying for compute.

What you get after this guide:

| Component       | Where                   | Notes                                                                                                 |
| --------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| API             | `http://localhost:3333` | A subset of the Apify API v2 (Actors, builds, runs, logs, datasets, key-value stores, request queues) |
| Console         | `http://localhost:3000` | A small web UI over the same state: Actors, builds, runs, logs, storages, settings                    |
| Builds and runs | Your own Docker daemon  | Actor images are built and run as containers next to the runtime, using the host's layer cache        |
| Data            | `./data` on the host    | Every storage, build record, run record, and log, inspectable as files                                |

Both ports are fixed. Everything described here works offline once the images are present; only the
sample Actors need the network, because they crawl the live web.

## Prerequisites

- **Docker.** Docker Desktop on macOS or Windows, or Docker Engine on Linux, running and reachable
  through `/var/run/docker.sock`.
- **Apify CLI.** `npm install -g apify-cli`. Any recent version works for the dev loop.
- **A login.** Run `apify login` once if you have not. The runtime maps any non-empty token to a
  local user, so you do not need a real Apify account. If the token is a real one and the platform is
  reachable, the runtime adopts your real username, id, and proxy password on first contact. Offline,
  or with a made-up token, you become `local-user-1`. Either way there is no error.

## 1. Start the runtime

You have two ways to start it. Pick one.

### With the Apify CLI (opt-in channel)

The Apify CLI ships `apify runtime` commands on the `runtime` npm dist-tag while they are in
development. They verify Docker, pull the runtime image, and start it with the canonical flags.

```bash
npm install -g apify-cli@runtime
apify runtime start --detach --data-dir ./data
```

Stop it later with `apify runtime stop`. The stable `apify-cli` does not have these commands yet, and
the image tag they pull is a temporary developer repository. See
[Ideal state: `apify local`](#ideal-state-apify-local) for where this is heading.

### With plain Docker

Build the image from this repository, or pull the published one, then run it:

```bash
docker build -t actor-runtime .
docker run --rm --name actor-runtime \
  -p 3333:3333 -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$(pwd)/data:/data" \
  actor-runtime
```

The Docker socket mount lets the runtime build and run Actor containers. The `./data` mount keeps
state across restarts. Add `-d` to run it in the background and `docker stop actor-runtime` to stop it.

The startup log prints a banner with both ports, plus a warning if the Docker socket is unreachable.
In that case storages and records still work, but builds and runs fail fast with a clear message.

> **Docker Desktop on macOS: ports hang.** On some Docker Desktop installations, requests to
> `localhost:3333` and `localhost:3000` time out even though the runtime is healthy. The runtime joins
> a second Docker network (`apify-local`) at startup so Actor containers can reach it, and Docker
> Desktop then routes replies the wrong way. Start the container on that network directly, with the
> alias Actor containers expect, so it has a single network:
>
> ```bash
> docker network create apify-local 2>/dev/null || true
> docker run --rm --name actor-runtime \
>   --network apify-local --network-alias apify-api \
>   -p 3333:3333 -p 3000:3000 \
>   -v /var/run/docker.sock:/var/run/docker.sock \
>   -v "$(pwd)/data:/data" \
>   actor-runtime
> ```
>
> The startup warning that the runtime "could not self-attach" to the network is expected and harmless
> in this setup. `apify runtime start` does not have this option yet; if it is affected, use the Docker
> command above until the runtime handles it on its own.

## 2. Point the Apify CLI at it

The CLI talks to whatever `APIFY_CLIENT_BASE_URL` and `APIFY_CONSOLE_URL` name. Set both in the shell
you develop in:

```bash
export APIFY_CLIENT_BASE_URL=http://localhost:3333
export APIFY_CONSOLE_URL=http://localhost:3000
apify info
```

`apify info` prints the user the runtime resolved for your token. To talk to the real platform again,
unset both variables. Nothing about your CLI login changes.

## 3. Push and run an Actor

Use one of the bundled samples, or your own Actor project:

```bash
cd sample_actor_ts
apify push
apify call --input '{"maxPages": 3}'
```

`apify push` creates the Actor and its version from the local source and starts a build. The first
build of an Actor downloads its base image and installs dependencies, so allow a minute; later builds
reuse Docker's layer cache and typically take seconds. `apify call` starts a run, streams its log, waits
for it to finish, and prints the run's default storage ids. Add `--json` to get them as JSON.

## 4. Inspect what happened

Open the console at [http://localhost:3000](http://localhost:3000) for the Actor, its builds, the run,
its log, and the dataset, key-value store, and request queue it produced. The same is available from
the CLI:

```bash
apify runs ls
apify datasets info <datasetId>
apify api v2/datasets/<datasetId>/items
apify api v2/key-value-stores/<storeId>/records/OUTPUT
apify api v2/actor-runs/<runId>/log
```

`apify api` sends any request to the runtime's API, so anything the console shows is reachable this
way too. The raw state is under `./data` if you want to look at the files; edit through the API
rather than on disk.

## 5. Stop and reset

- **Stop:** `docker stop actor-runtime` (or Ctrl+C in the foreground), or `apify runtime stop`.
- **Keep state:** start it again with the same `./data` mount, and every Actor, build, run, and
  storage is still there.
- **Reset:** stop the runtime and delete `./data`. The next start is a clean slate. Built Actor images
  stay in your Docker daemon and are reused if you push the same source again.

## Next steps

- [Local development workflow](local-development.md): the full dev loop, iterating without rebuilds,
  IDE debugging, migration and abort testing, multiple users, platform fallback, and limitations.
- `requirements/*.md` in this repository is the behavioural spec if you need the exact rules.

## Ideal state: `apify local`

> **Proposal.** Nothing in this section exists yet. It describes the developer experience this
> project is aiming for, so the gap is visible and can be closed piece by piece without breaking
> anything that works today.

The target is that the Apify CLI is the only tool you need, the way `supabase start` gives you a
whole local stack:

```bash
npm install -g apify-cli
apify local start          # pull if needed, start, print how to connect
apify push && apify call   # in your Actor folder
apify local stop
```

Proposed command group, mirroring the shape of the shipped `apify runtime` commands and extending it:

| Command                                           | Does                                                                                                                                                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apify local start [--detach] [--data-dir <dir>]` | Verifies Docker, pulls the runtime image from an Apify-owned registry if missing, starts the container with the correct flags for the host, and prints the connection details. Defaults the data directory to `~/.apify/actor-runtime/data`. |
| `apify local stop`                                | Stops the runtime container.                                                                                                                                                                                                                 |
| `apify local status`                              | Reports whether the runtime is up, its ports, the data directory, image version, and the number of running Actor containers. Exits non-zero when it is down, so scripts can rely on it.                                                      |
| `apify local env`                                 | Prints the `export` lines for `APIFY_CLIENT_BASE_URL` and `APIFY_CONSOLE_URL`, so `eval "$(apify local env)"` points a shell at the local runtime, the way `supabase status -o env` does.                                                    |
| `apify local reset`                               | Stops the runtime and clears its data directory after confirmation.                                                                                                                                                                          |
| `apify local logs [-f]`                           | Tails the runtime's own log.                                                                                                                                                                                                                 |

Behaviours that go with it:

- **Correct networking on every host.** `apify local start` (and the runtime itself) handles the Docker
  Desktop routing issue described in step 1, so the workaround disappears.
- **One published image.** The image lives under Apify's own registry namespace with versioned tags,
  and the CLI knows which version it expects.
- **A stable channel.** The commands live in the stable `apify-cli`, not an opt-in dist-tag.

**Why `local` when `apify runtime` already exists.** The `runtime` commands are the first step of this
plan and already prove the mechanics: they are on the `runtime` npm dist-tag today, and a spec for them
lives on the `claude/actor-runtime-cli-distribution-mo0u94` branch as `requirements/distribution.md`.
The proposal is to graduate them under the name `local` when they reach the stable CLI: it names what
the developer gets, a local platform, rather than the repository that implements it, and it reads the
same way as the tools people already know. Until that decision is made, `apify runtime` is the
working CLI path and this page documents it as such.
