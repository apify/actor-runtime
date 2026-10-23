# actor-runtime as a standby Actor

Runs the whole runtime (API + console) as an Apify Actor with Actor Standby, so one standby URL serves
both. Built from this branch; see `requirements/hosted.md` for the behavior.

## Push and try it

```bash
cd standby-actor
./sync.sh          # copies ../src, ../skills, ../package.json ... into ./runtime
apify push         # needs `apify login`
```

Then enable **Actor Standby** for `actor-runtime-standby` in the Console (set the idle timeout; give it at
least 2 GB) and call it with your token:

```bash
URL=https://<username>--actor-runtime-standby.apify.actor
curl -H "Authorization: Bearer $APIFY_TOKEN" $URL/v2/users/me
open "$URL/?token=$APIFY_TOKEN"        # console; swaps the token for a cookie
```

Pushing an Actor to it: use the same token and `$URL/v2` as the API base URL.

## What will NOT be possible

- **No containers.** Docker cannot run inside an Apify Actor, so Actors run as plain processes in a
  chroot of their unpacked image. No Docker daemon, no `docker` in builds.
- **No resource limits or isolation.** The memory/CPU an Actor asks for is not enforced; all runs share
  this Actor's memory, CPU, disk and network and can see each other's ports.
- **Reduced Dockerfile support.** `FROM` (multi-stage ok), `ARG`, `ENV`, `WORKDIR`, `USER`, `COPY`, `ADD`
  (as `COPY`), `RUN`, `CMD`, `ENTRYPOINT`. Not: `.dockerignore`, `RUN --mount`, heredocs, remote/archive
  `ADD`, caching (every build pulls and runs from scratch).
- **Slower builds.** `RUN` steps go through `proot` (ptrace) so that `/proc` exists; CPU-heavy compiles
  (Rust, C++) run slower than in a container. Set `ACTOR_RUNTIME_PROCESS_SANDBOX=chroot` to skip it, at the
  cost of `/proc` (rustup/cargo then fail).
- **No dev folder, debug mode, browser view, or migration testing.**
- **No persistence.** Storages live on the Actor's disk and are gone when the standby run ends (idle
  timeout, migration, abort). Use it for experiments.
- **Owner only.** Other accounts' tokens get 403. Nothing is public.
- **Platform standby limits** apply: idle shutdown, request timeouts, and a cold start of a few seconds
  before the first request is answered.
- **Not verified on the platform yet:** WebSocket pass-through (the events websocket), whether the
  chroot is allowed (the startup log says if it falls back to `proot` or marks the driver unavailable),
  and registry/npm egress from the Actor.

If a build fails with `chroot: cannot change root directory`, the platform denied it: check the Actor's
run log first, that is the result the probe of this branch is meant to give.
