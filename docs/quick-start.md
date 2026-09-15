# Quick start

Learn how to build, run, and inspect [Actors](https://docs.apify.com/actors) on your own machine with the local Actor runtime.

The local Actor runtime is a single container that emulates the parts of the Apify platform the Actor development loop needs. You use the same Apify CLI commands as against the platform, but builds and runs happen on your computer and no platform compute is used.

It is a development tool, not a place to host Actors. Everything it creates lives in one data directory on your machine and disappears when you delete it.

## Before you start

- **A container engine.** [Docker](https://docs.docker.com/get-docker/) (Docker Desktop on macOS or Windows, Docker Engine on Linux) or [Podman](https://podman.io/docs/installation), rootful or rootless. Whichever you use must be running: Docker's daemon, or Podman's API socket. The CLI picks the first of `docker`, `podman` it finds on your `PATH`; set `APIFY_CONTAINER_ENGINE=podman` to force the choice.
- **Apify CLI from the `runtime` channel.** The `apify runtime` commands are still in preview and do not ship on `latest` yet:

    ```
    npm install -g apify-cli@runtime
    ```

    Then check that the command you actually get is the one you just installed:

    ```
    apify --version
    ```

    It must report `1.10.1-runtime.x ... installed via npm`. If it reports something else, or `apify runtime install` answers `Error: Command runtime not found`, your shell is still resolving an older `apify` - the standalone bundle installer puts one in `~/.local/bin`, Homebrew puts one in its own prefix, and `npm install -g` does not replace either. Run `hash -r` (or open a new terminal) and check again; if the version is still wrong, `which -a apify` shows which copy wins.

    A local install sidesteps the clash entirely, and leaves the stable `apify` on your machine alone:

    ```
    npm install apify-cli@runtime
    ./node_modules/.bin/apify --version
    ```

- **A login.** Run `apify login` once. You do not need a real Apify account: the runtime accepts any non-empty token, so `apify login --token local-dev-token` is enough. In a sandbox with no OS keyring, set `APIFY_DISABLE_KEYRING=1` first - but note that this writes to `~/.apify/auth.json` and replaces whatever credentials were there.

    If you log in with a real Apify token and your machine is online, the runtime calls the real `api.apify.com` once and adopts that account's username, id, and proxy password. Offline, or with a made-up token, you become `local-user-1` instead. Neither path errors.

## 1. Install and start the runtime

```
apify runtime install
apify runtime start --detach
```

`apify runtime install` checks that your container engine is reachable and pulls the runtime image (`apify/actor-runtime:latest`). Pass a tag to pin a specific one - `apify runtime install apify/actor-runtime:master-5462005` - and `--force` to re-pull a tag that has moved. Whichever image you installed last is the one `start` runs.

`apify runtime start` runs the container, publishing the API on port `3333` and the console on port `3000`. Both ports are fixed. Without `--detach` it stays in the foreground and Ctrl+C stops it.

Runtime data - storages, builds, and run records - goes to `~/.apify/actor-runtime/data` by default. Pass `--data-dir ./data` to keep it next to your Actor instead. The directory is a host mount, so it survives restarts.

**One runtime at a time.** The container name and both ports are fixed, so a second `apify runtime start` fails while one is running. A single runtime serves as many Actors as you like; the data directory, not the runtime, is the unit of isolation.

### Check that it is running

```
apify runtime status
```

It prints the engine, the image, the data directory the running container actually has mounted, the published ports, and which API your CLI currently talks to. It exits with code `1` when the runtime is not running - including when it died on its own - so scripts can test for it.

To stop it later, run `apify runtime stop`. The container is started with `--rm`, so stopping also removes it; your data directory stays.

### If both ports hang on macOS

On some Docker Desktop installations every request to `localhost:3333` and `localhost:3000` times out even though the runtime is healthy - `docker logs apify-actor-runtime` shows the normal startup banner, and `apify login` simply hangs with no error. The cause is that the runtime self-attaches to its own `apify-local` network while also on `bridge`, and Docker Desktop then routes the replies back the wrong way.

Confirm it with `docker inspect apify-actor-runtime --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'`: two networks means you have hit this.

`apify runtime start` cannot work around it yet - there is no flag for the container's network - so start it by hand on that one network instead:

```
docker network create apify-local 2>/dev/null || true
docker run --rm --init -d --name apify-actor-runtime \
  --network apify-local --network-alias apify-api \
  -p 3333:3333 -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$HOME/.apify/actor-runtime/data:/data" \
  apify/actor-runtime:latest
```

Everything after this point works normally, `apify runtime stop` included. The startup warning that the runtime could not self-attach to the network is expected here.

<details>
<summary>Starting it with Docker or Podman directly</summary>

The CLI is a wrapper around one `docker run`. To run the image by hand, or to build it from a checkout of this repository:

```
docker build -t actor-runtime .
mkdir -p data
docker run --rm --init --name apify-actor-runtime \
  -p 3333:3333 -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$(pwd)/data:/data" \
  actor-runtime
```

The engine socket mount is what lets the runtime build and start Actor containers. The data directory must exist before you start - Podman does not create it for you.

For Podman, mount its socket in place of Docker's (`-v /run/podman/podman.sock:/var/run/docker.sock`, or `$XDG_RUNTIME_DIR/podman/podman.sock` when rootless). See "Running with Podman instead of Docker" in the [README](../README.md) for the details.

</details>

## 2. Point the Apify CLI at the runtime

```
apify runtime connect
```

From then on every Apify CLI command goes to the local runtime instead of the Apify platform, in every terminal, until you run:

```
apify runtime disconnect
```

The connection is one flag in `~/.apify/actor-runtime/config.json`. It is global to your machine - there is no per-directory or per-project scope, and no named profiles. Your login is untouched either way.

To aim one shell only, set the two URLs there instead. They take precedence over `apify runtime connect` wherever they are set, which is what `apify runtime status` warns about when it finds them:

```
export APIFY_CLIENT_BASE_URL=http://localhost:3333
export APIFY_CONSOLE_URL=http://localhost:3000
```

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

    Pushing the same unmodified source again is refused with "already exists on the platform and has newer changes than your local copy" - the runtime bumps the Actor's `modifiedAt` when a build completes, so it looks newer than your files. Use `apify push --force`.

3. Compile the Actor locally, if your language needs it:

    ```
    npm install && npm run build
    ```

    This is not optional, and it is easy to miss. Your first push registers this directory as the Actor's dev folder (see [step 5](#5-edit-your-actors-code-without-rebuilding)), and every run mounts it over the built image - which hides the `dist/` the image built for itself. A TypeScript Actor with no local `dist/` therefore fails its very first run with `Error: Cannot find module '/usr/src/app/dist/main.js'`, even though the build succeeded. Interpreted Actors (Python, plain JavaScript) have nothing to compile and can skip this.

4. Run the Actor:

    ```
    apify call
    ```

    The run uses the input from your local `storage/key_value_stores/default/INPUT.json`. To pass a different input, add `--input '{"key": "value"}'` or `--input-file input.json`. The CLI streams the run log and prints the run's default storage ids when it finishes. Add `--json` to get them as JSON.

In the log, every line the runtime itself wrote opens with a blue `[actor-runtime]` prefix. Your Actor's own output is passed through untouched.

**`apify call`, not `apify run`.** `apify run` executes your Actor as a plain process on your machine, with no container and no platform around it - that is unchanged and unaffected by the runtime. `apify call` starts a real Actor run in the runtime: the built image, platform environment variables, real storages, a run record, migrations. Use `apify call` for anything you want to behave like the platform.

**No Actor yet?** Create one with [`apify create`](https://docs.apify.com/cli/docs/quick-start), or use `sample_actor_ts` in this repository, which takes `--input '{"maxPages": 3}'`.

## 4. View the results

Open the console at [http://localhost:3000](http://localhost:3000) for the Actor, its builds, the run, its log, and the storages it produced.

From the CLI, list the runs of your Actor:

```
apify runs ls
```

To read what a run produced, use the ids `apify call` printed:

| Command                                                  | Shows                                  |
| -------------------------------------------------------- | -------------------------------------- |
| `apify runs log <runId>`                                 | The run log                            |
| `apify datasets info <datasetId>`                        | Dataset metadata, including item count |
| `apify datasets get-items <datasetId> --format json`     | Dataset items                          |
| `apify api v2/key-value-stores/<storeId>/records/OUTPUT` | One key-value store record             |

`apify api` sends any request to the runtime API, so every Actor, build, run, log, and storage is available this way. The raw files are in the data directory. Read them freely, but change state through the API.

## 5. Edit your Actor's code without rebuilding

Your first `apify push` registers the pushed directory as the Actor's **dev folder**, and every later run mounts it over the built image. Edit, recompile locally, and run again - no push, no build:

1. Change the source in your Actor directory, for example `src/main.ts`.

2. Compile the code, if your language needs it:

    ```
    npm run build
    ```

3. Run the Actor again:

    ```
    apify call
    ```

A run that uses the dev folder says so in its log, in a `Local Actor runtime` banner naming the mounted path.

Three things to know:

- Edits apply to the **next** run you start, not to a run already in progress.
- `node_modules` still comes from the built image. A change to `package.json` or `requirements.txt` needs a real `apify push --force` and a rebuild; only source edits skip it.
- `apify call --no-dev-folder` runs once from the built image alone, leaving the registration in place. To clear the registration for good, or to point it somewhere else, use `apify api POST /actor-runtime/dev-folder/<actorId> --body '"/abs/path/to/src"'` (`--body '""'` clears it). The same field is a form on the Actor's page in the console.

The path is resolved on the machine your container engine runs on. Under `podman machine`, or Docker Desktop's VM, that is not always the same as your own filesystem.

## 6. Go further

The runtime ships its own reference for everything beyond the basic loop - debugging a run with a real IDE debugger, watching a Playwright or Puppeteer browser live, rehearsing platform migrations, and relaying unimplemented API calls to the real platform:

```
apify runtime skill             # read it now
apify runtime skill --install   # install it as an Agent Skill, for coding agents
```

It is also served by a running runtime at `http://localhost:3333/actor-runtime/skill`, unauthenticated.

## 7. Stop and reset

- To stop, run `apify runtime stop`, or Ctrl+C if you started it in the foreground.
- To keep your data, start the runtime again with the same data directory.
- To reset, stop the runtime and delete the data directory. Built Actor images stay in your container engine and are reused when you push the same source again.
