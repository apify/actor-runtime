# Contributing to actor-runtime

## Building and running from source

```bash
docker build -t actor-runtime .
mkdir -p data
docker run --rm -p 3333:3333 -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$(pwd)/data:/data" \
  actor-runtime
```

`./data` on the host becomes the runtime's `/data`, so every storage, build and run record lands there
for inspection. To drive a locally built image with the CLI, point `apify runtime install` at it. With
Podman, build with `podman build` and mount Podman's socket as described in README.md's "Running with
Podman instead of Docker". `podman images` lists the images the runtime builds as
`actor-runtime/<actor>:<buildId>`, under the registry prefix Podman adds (`docker.io/` or `localhost/`).

To point the CLI at it without `apify runtime connect`:

```bash
export APIFY_CLIENT_BASE_URL=http://localhost:3333
export APIFY_CONSOLE_URL=http://localhost:3000
```

The sample Actors (`sample_actor_*`) crawl the live web, so running them needs network access.

## Specification

The behavioural spec lives in `requirements/*.md`: `system.md`, `api.md`, `storage.md`,
`actor-driver.md`, `cli.md`, `console.md` and `test.md`. `unsupported.md` lists the platform behaviour
the runtime deliberately leaves out.

User-facing documentation lives in `skills/actor-runtime/SKILL.md`, which ships inside the image. When
a change alters what the runtime does for its users, update it in the same commit. Contribution
conventions for requirements, code comments and pull requests are in [CLAUDE.MD](CLAUDE.MD).

## Development

```bash
pnpm install
pnpm run build     # tsc
pnpm test          # unit + integration (no Docker needed)
pnpm run test:e2e  # full CLI-driven dev loop against a built image (requires Docker, or Podman with CONTAINER_CLI=podman; the browser-view case pulls the ~2 GB Playwright base image)
pnpm run dev       # run the server directly against ./data with tsx
```

`pnpm run dev` sets `ACTOR_RUNTIME_DATA_DIR=./data` inline in the script (`DEFAULT_DATA_DIR` otherwise
falls back to the container path `/data` - see `src/config.ts`); this only works as written on a
POSIX shell (Linux/macOS). On Windows, set the env var separately before running `tsx src/index.ts`
(e.g. in PowerShell: `$env:ACTOR_RUNTIME_DATA_DIR="./data"; tsx src/index.ts`), or use a cross-platform
env-setter like `cross-env` if you add it as a dependency.

## Bumping the pinned Crawlee v4 version

`@crawlee/core` and `@crawlee/fs-storage` are pinned to the exact version the npm `v4` dist-tag
resolves to (both must move in lockstep - `@crawlee/fs-storage` pins its own native addon,
`@crawlee/fs-storage-native`). To bump:

```bash
pnpm view @crawlee/core dist-tags.v4
pnpm view @crawlee/fs-storage dist-tags.v4   # should match
# update both versions in package.json, then:
pnpm install
pnpm run build && pnpm test
```

While bumping, check whether the `pnpm.overrides` pin on `@crawlee/fs-storage-native` in
`package.json` is still needed: it forces the first release with linux-arm64 bindings
(`0.1.5-beta.19`, API-identical to the `0.1.5-beta.18` that released `@crawlee/fs-storage`
versions still depend on). Once the bumped `@crawlee/fs-storage` depends on `>= 0.1.5-beta.19`
on its own, delete the override.

## Publishing the image

Images go to [`apify/actor-runtime`](https://hub.docker.com/r/apify/actor-runtime) on Docker Hub by
default; the target repository is a workflow input, so a one-off build can be pushed elsewhere.

The **Release Docker image** workflow (`.github/workflows/release.yml`) is manual only: Actions ->
Release Docker image -> Run workflow, pick the branch in **Use workflow from**, and run it. That is
the only branch to choose - the workflow always builds the branch it was dispatched from. Everything
else is optional: an extra tag such as `v0.1.0`, whether to also move `:latest`, and which platforms
to build.

It pushes one multi-arch manifest per tag - `linux/amd64` and `linux/arm64` by default - so the same
tag serves x86_64 and Apple Silicon. Every run publishes `<branch>-<short-sha>` (immutable) and
`<branch>` (moving), with `/` in a branch name slugified to `-`. It pushes as the Apify service
account, using the same two repository secrets as
[apify-actor-docker](https://github.com/apify/apify-actor-docker):
`APIFY_SERVICE_ACCOUNT_DOCKERHUB_USERNAME` and `APIFY_SERVICE_ACCOUNT_DOCKERHUB_TOKEN`. They are
synced into this repository's Actions secrets from the org's secret manager, so they are managed
there rather than added by hand.

### Deleting published tags

Per-branch and per-commit tags pile up on Docker Hub as branches come and go. The **Delete Docker
image tags** workflow (`.github/workflows/delete-image-tags.yml`) removes them: Actions -> Delete
Docker image tags -> Run workflow, then give it the tags to delete - comma- or newline-separated,
either exact tag names or shell-style globs matched against the repository's current tags
(`claude-*`, `master-*`, `*` for everything deletable). The repository it deletes from is hardcoded
to `apify/actor-runtime`, unlike the release workflow's target: it deletes, so it can only ever reach
the one repository it is written for.

`master`, `main` and `latest` are never deleted: a glob covering one of them skips it and says so, so
the tags users pull cannot be removed from here. Every other tag in the repository can be.

Runs are a dry run by default - they list what would go and delete nothing. Uncheck **dry_run** to
delete for real. Either way the run summary lists the tags. It authenticates with the same two
service-account secrets as the release workflow; the token needs delete permission on the repository,
or each delete comes back 403.

Deleting a tag only removes that tag. The manifest and layers stay until Docker Hub's own garbage
collection reclaims them, and any other tag pointing at the same digest keeps working - so deleting
`master-<sha>` does not break `master` when both point at the same build.
