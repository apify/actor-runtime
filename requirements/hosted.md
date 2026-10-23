# Hosted mode (the runtime as a standby Actor)

The runtime can run as an Apify Actor with Actor Standby on, so that the platform's standby URL serves
its API and console. It is meant for trying Actors against a remote runtime, not for production hosting.

## Behavior

- Hosted mode is on when the runtime runs on the Apify platform with a standby port, or when
  `ACTOR_RUNTIME_HOSTED=1`.
- API and console share the standby port. Paths under `/v2` and `/actor-runtime` are the API (including
  the events websocket, run web servers and nested standby Actors, `api.md`); every other path is the
  console (`console.md`).
- Only the owner's Apify token is accepted, as `Authorization: Bearer`, `X-Apify-Authorization` or
  `?token=`. Any other token gets `403`, none gets `401`. A console page opened with `?token=` sets a cookie
  and redirects, so the rest of the console needs no token; the cookie is never honoured on the API.
- The platform's readiness probe is answered without a token.
- Actors build and run without a container engine (`actor-driver.md` differences below); the driver is
  chosen by `ACTOR_RUNTIME_DRIVER` (`docker` or `process`), `process` by default when hosted.
- The startup log lists everything below that is not available.

## Not possible when hosted

- Containers: Actors run as plain processes in a chroot of their unpacked image, as root.
- Per-run memory and CPU limits, and isolation between runs. Runs share the runtime Actor's memory, CPU,
  disk and network.
- Dockerfile features beyond `FROM` (multi-stage included), `ARG`, `ENV`, `WORKDIR`, `USER`, `COPY`, `ADD`
  (as `COPY`), `RUN`, `CMD`, `ENTRYPOINT`: no `.dockerignore`, `RUN --mount`, heredocs, remote or archive
  `ADD`, build cache.
- Local dev folder, debug mode, browser view and migration testing.
- Offline use: images are pulled from their registry on every build.
- Storages surviving the Actor run: they live on its disk.
- Access for anyone but the owner, and the Standby limits of the platform (idle shutdown, request timeout).
