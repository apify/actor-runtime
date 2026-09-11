# API specification

- The API implements a subset of the OpenAPI specification `https://docs.apify.com/api/openapi.json`

# Response envelopes

- Every JSON response wraps its payload as `{ "data": ... }` - apify-client-js unwraps every response
  and would otherwise hand the CLI/SDK `undefined`.
- Every error response is `{ "error": { "type": "...", "message": "..." } }`. A request for a resource
  id that does not exist (or does not belong to the caller) answers HTTP `404` with error type
  `record-not-found` - the exact type apify-client-js keys its "return `undefined` instead of
  throwing" behaviour off, which `apify push`'s "does this Actor already exist" probe depends on. This
  applies uniformly to every `DELETE` in the Public API list below (Actors/builds/runs, datasets,
  key-value-stores, request queues), matching the Apify platform. The one documented exception:
  deleting a key-value-store _record_ whose key does not exist inside an otherwise-existing store is a
  `204` no-op, matching the platform.
- `DELETE /v2/actor-builds/:buildId` and `DELETE /v2/actor-runs/:runId` on a **non-terminal** build/run
  are rejected, not aborted-then-deleted: `400` with error type `deleting-unfinished-build` (builds) or
  `cannot-remove-running-run` (runs), matching the Apify platform.
- Four endpoints are exceptions to the `{data}` envelope:
    - `GET /v2/logs/:buildOrRunId` (and its `actor-builds`/`actor-runs` aliases): the body is plain text,
      never `{data}`-wrapped, matching apify-client-js's `log().get()`.
    - `GET /v2/datasets/:datasetId/items` (and its `actor-runs/:runId/dataset/items` alias): the body is
      a bare JSON array of items, never `{data}`-wrapped, with pagination metadata carried in
      `x-apify-pagination-*` response headers, matching apify-client-js's pagination handling.
    - `GET /actor-runtime/events/:runId`: a websocket upgrade, not a JSON response at all - see "Actor
      runtime API" below.
    - `GET /actor-runtime/openapi.json`: the runtime's own OpenAPI document, served bare so standard
      OpenAPI tooling can consume the URL - see "Actor runtime API" below. The same document _is_
      `{data}`-enveloped at `GET /actor-runtime`, which is what the CLI reads.
- `*At` timestamp fields are ISO-8601 strings.
- Log content matches the Apify platform's log format: every log line starts with an ISO-8601 UTC
  timestamp with millisecond precision followed by a space (`2026-08-31T09:13:25.123Z `), exactly one
  timestamp per line regardless of how the output was chunked when produced. Apify clients' log
  redirection (e.g. `Actor.call` in the SDKs) relies on this prefix to recognize log messages.

# Actor id encoding

- `:actorId` accepts the real id, the plain Actor `name`, or `username~name` (a literal `/` in a
  client-supplied identifier is rewritten to `~` by apify-client-js before the request is sent). This
  is how stock `apify push` finds an existing Actor by name before an id has ever been minted.

# 501 vs 404

- This section is about the emulated platform surface only. The `/actor-runtime/*` namespace has its
  own specification and its own rule for what it does not describe - see "Actor runtime API" below.
- Which endpoints answer `501` (unimplemented spec path) instead of `404` (off-spec path entirely) is
  decided from a fixed, built-in list of known Apify API v2 spec paths - nothing is fetched from
  `docs.apify.com` at runtime. See "Known differences from the Apify platform" in `storage.md` for the
  specific spec paths this runtime answers `501` on by design (request deletion) rather than because
  they are simply unbuilt.

# Public API

- It implements these API paths:
    - Actors
        - v2/actors
        - v2/actors/:actorId
        - v2/actors/:actorId/builds
        - v2/actors/:actorId/builds/default
        - v2/actors/:actorId/runs
        - v2/actors/:actorId/versions
        - v2/actors/:actorId/versions/:versionNumber
    - Builds
        - v2/actor-builds
        - v2/actor-builds/:buildId
        - v2/actor-builds/:buildId/abort
        - v2/actor-builds/:buildId/log
    - Runs
        - v2/actor-runs
        - v2/actor-runs/:runId
        - v2/actor-runs/:runId/abort
        - v2/actor-runs/:runId/reboot
        - v2/actor-runs/:runId/log
    - Datasets
        - v2/datasets
        - v2/datasets/:datasetId
        - v2/datasets/:datasetId/items
        - v2/datasets/:datasetId/statistics
    - Key-value stores
        - v2/key-value-stores
        - v2/key-value-stores/:storeId
        - v2/key-value-stores/:storeId/keys
        - v2/key-value-stores/:storeId/records/:recordKey
    - Request queues
        - v2/request-queues
        - v2/request-queues/:queueId
        - v2/request-queues/:queueId/requests/batch
        - v2/request-queues/:queueId/requests
        - v2/request-queues/:queueId/requests/:requestId
        - v2/request-queues/:queueId/requests/:requestId/lock
        - v2/request-queues/:queueId/head
        - v2/request-queues/:queueId/head/lock
        - v2/request-queues/:queueId/requests/unlock
    - Logs
        - v2/logs/:buildOrRunId
    - Users
        - v2/users/me
        - v2/users/:userId
    - Default run storages
        - v2/actor-runs/:runId/dataset
        - v2/actor-runs/:runId/dataset/items
        - v2/actor-runs/:runId/dataset/statistics
        - v2/actor-runs/:runId/key-value-store
        - v2/actor-runs/:runId/key-value-store/keys
        - v2/actor-runs/:runId/key-value-store/records/:recordKey
        - v2/actor-runs/:runId/request-queue
        - v2/actor-runs/:runId/request-queue/requests/batch
        - v2/actor-runs/:runId/request-queue/requests
        - v2/actor-runs/:runId/request-queue/requests/:requestId
        - v2/actor-runs/:runId/request-queue/requests/:requestId/lock
        - v2/actor-runs/:runId/request-queue/head
        - v2/actor-runs/:runId/request-queue/head/lock
        - v2/actor-runs/:runId/request-queue/requests/unlock

- The implemented API paths implement all http methods mandated by the OpenAPI specification, with
  documented exceptions that are real spec paths this runtime deliberately cannot serve and answers
  `501` on instead of implementing:
    - `DELETE .../requests/:requestId` and `DELETE .../requests/batch` (both on
      `v2/request-queues/:queueId/*` and their `actor-runs/:runId/request-queue/*` aliases) - see
      `storage.md`'s "Known differences from the Apify platform".
    - `GET v2/key-value-stores/:storeId/records` (no `:recordKey`) and its
      `v2/actor-runs/:runId/key-value-store/records` alias - on the real platform this downloads every
      record in the store as a zip archive. Unrelated to `.../records/:recordKey` (single-record
      read/write/delete) just above, which this runtime does implement. Both paths answer `501`, not
      `404`.
- All endpoints from the specification that do not have implementation must return response `501 Not Implemented`
- All endpoints not present in specification must return `404 Not Found` - **except** `/actor-runtime/*`,
  which is not part of the Apify API at all and answers from its own specification instead ("Actor
  runtime API" below)

# Actor runtime API

- `/actor-runtime/*` is the API controlling functions specific to the local Actor runtime: developer
  conveniences (live dev folder, debug mode, browser view, migration emulation, upstream API fallback,
  the per-run events channel) that the real Apify platform API has no counterpart for.
- **The namespace has its own OpenAPI specification**, committed at `src/api/openapi/actor-runtime.json`.
  That document is the normative contract for every endpoint in it - paths, methods, request bodies,
  response payloads, per-rejection error `type`s, and worked examples. This file does not repeat it:
  the sections below state only what OpenAPI cannot express (behaviour over time, cross-surface
  consistency, and the guarantees the fallback and migration features rest on).
- **The runtime serves that specification from itself**, so a client can enumerate what a given
  runtime supports rather than hard-coding a list:
    - **`GET /actor-runtime`** - the document in the usual `{data}` envelope, so it reads through
      apify-client-js and therefore through `apify api GET /actor-runtime` (`cli.md`).
    - **`GET /actor-runtime/openapi.json`** - the same document unenveloped, for OpenAPI tooling
      pointed straight at the URL.
    - Both are **unauthenticated**, unlike every other endpoint in the namespace: the document is
      static, identical for every caller and carries no user data, so a client can identify a local
      Actor runtime and enumerate its capabilities before it holds a token.
    - The document's `info.version` is the runtime's own version.
- Every endpoint in the namespace is served at both `/actor-runtime/*` (canonical) and
  `/v2/actor-runtime/*` (the same routes, reachable a second way purely because `apify api` builds
  every URL against a base that already ends in `/v2`). Neither mount is part of the emulated Apify
  API, and neither is ever relayed upstream (see "Upstream fallback" below).
- Every endpoint except the two specification endpoints above and the events websocket (below) is
  **authenticated** the same way as every `/v2` route and **scoped to the caller's own** Actors/runs,
  and none has a **build-first precondition** - a toggle can be set for an Actor that has never been built at all. The endpoints
  that set a per-Actor toggle (dev folder, debug mode, browser view) have no separate `GET`: each
  response body doubles as the read-back, and each call fully replaces the prior state rather than
  merging into it.
- **Anything under `/actor-runtime/*` that the specification does not describe is answered from the
  specification**, never from the emulated platform surface:
    - an undescribed path answers `404` `not-found`, with a message pointing at `GET /actor-runtime`;
    - a described path addressed with an undescribed method answers `405` `method-not-allowed` with an
      `Allow` header naming the methods it does have;
    - a plain HTTP request to the events websocket path answers `426` `upgrade-required`.
- The console's own dev-folder, debug-mode and browser-view forms (`console.md`) do **not** go through
  these endpoints - they post to console-local, unauthenticated routes on the console's own port - but
  the two surfaces accept and reject exactly the same inputs with the same outcomes.
- **`POST /v2/actors/:actorId/runs?devFolder=false`** - runs from the built image alone, ignoring the
  registered dev folder for that one run only; the registration itself is unchanged. Any other value,
  or no parameter, means the default behaviour. A runtime-only query parameter on an otherwise
  faithful platform endpoint, so it lives on the platform surface rather than in this namespace; the
  specification lists it under `x-actor-runtime-platform-extensions` so a client enumerating the
  document still sees it.
- **The events websocket** (`GET /actor-runtime/events/:runId`) carries the run's platform events:
  `systemInfo` once a second (`actor-driver.md`), a one-off `aborting`-plus-`persistState` pair under
  `?gracefully=` (below), and a one-off `migrating` frame when a migration is triggered ("Migration
  emulation" below). It is reachable at exactly this one path on the fixed API port (`system.md`).
    - The endpoint has no authentication. The run id in the path is the only thing it scopes on, and a
      connection only ever receives that run's own frames; one run never sees another's.
    - An unknown or already-terminal run id gets a completed upgrade followed immediately by a `1008`
      close with a reason, never a non-101 HTTP status - the Python SDK treats a refused first connection
      as fatal to the Actor.
    - A connection to a live run stays open until the run ends, when the server closes it with `1000`. It
      is never dropped while healthy, except that a graceful runtime shutdown terminates every open
      connection along with the rest of the server. A migration/reboot restart is not the run ending: the
      restarted container reconnects to the same path.
    - The _periodic_ `persistState` is never sent over this channel; both SDKs generate it themselves.
      The server sends `persistState` exactly once per graceful abort, alongside `aborting` (matching the
      platform), and never alongside `migrating` (the SDKs synthesize that one).

## Graceful abort (`?gracefully=`)

- `POST /v2/actor-runs/:runId/abort` accepts an optional `?gracefully=` boolean.
- Omitted or `false`: the run aborts immediately.
- `true` on a running run: the record moves to `ABORTING` at once, an `aborting` frame plus a
  `persistState {"isMigrating": false}` frame (in that order, matching the platform) are published on
  the run's events channel, and the container is stopped 30 seconds later. The request stays open until
  then.
- `true` on a run with no container (still `READY`, or already terminal): behaves as if omitted.
- A second abort arriving during an open window: another `?gracefully=true` joins that window and neither
  restarts it nor stops the container early; a non-graceful one escalates and stops the container at once.

## Migration emulation (`POST /actor-runtime/migrate/:runId`) and reboot

A platform migration is not a run status: the run stays `RUNNING` while its container is killed and a
new one starts for the same run - same run id, env vars, and default storages, in-memory state gone.
This runtime emulates that observable experience on demand:

- **`POST /actor-runtime/migrate/:runId`** (also at `/v2/actor-runtime/migrate/:runId`) - authenticated
  like the rest of this namespace, scoped to the caller's own runs. The console's run detail view
  exposes the same trigger as a Migrate button (`console.md`).
    - Publishes a `migrating` frame (empty payload) on the run's events channel immediately, stops the
      container 5 seconds later (the platform promises only "a few seconds"), then restarts the same
      run. Status stays `RUNNING`; `startedAt`, `finishedAt`, `exitCode`, the default storage ids, and
      the container env are unchanged. `stats.migrationCount` increments once per performed stop.
    - Responds immediately with the run object (same shape as `abort`/`reboot`). A second call during
      the open window joins it: same response, no second frame or window.
    - The timeout budget is per run, not per container: a restarted container gets only the remaining
      `timeoutSecs`.
    - An abort (graceful or hard) landing during the window or restart wins: the run ends `ABORTED`,
      never restarted.
- **`POST /v2/actor-runs/:runId/reboot`** - the real platform endpoint the SDKs call from their default
  `migrating` handler. Stops and restarts the run's container immediately (no warning frame), cancels an
  open migration window, and increments `stats.rebootCount`. A finished run is `403` `job-finished`; a
  non-terminal run with no container (`READY`, `ABORTING`) gets the count bump but no restart.
- The run object's `stats` carries `migrationCount`, `rebootCount`, `restartCount`, and `resurrectCount`
  (the latter two always `0` here), initialized to `0` at run creation like the platform.
- The run's log is cumulative across restarts, with a one-line marker between the incarnations' output.

## Upstream fallback (opt-in, off by default, all HTTP methods)

- Two independent booleans, `fallbackUnimplementedEnabled` and `fallbackNotFoundEnabled`, gate whether
  a request this runtime cannot satisfy locally is instead relayed to the real Apify platform. Both
  default to `false`, and a restart always brings both back to `false`, regardless of how they were
  last set. Either can be on without the other; all four combinations are valid.
- **`GET`/`POST /actor-runtime/api-fallback`** read and change that state; the request and response
  shapes are in the specification. `POST` is a partial update - a field the body doesn't mention keeps
  its current value - and is the only way to change the state: `upstreamBaseUrl` is reported on every
  response for visibility but is read-only (it is the platform this runtime would relay to,
  `https://api.apify.com` by default, or the value of `APIFY_UPSTREAM_API_BASE_URL`). A rejected body
  changes nothing, not even the fields that would have passed on their own.
- **Which local outcome each toggle covers** (exhaustive - every other error response is never
  eligible, under any toggle combination):
    - `fallbackUnimplementedEnabled` covers a request the runtime does not serve at all: a local `404`
      or `501` response (see "501 vs 404" above). From the caller's point of view both mean "nothing
      local answers this", so one toggle covers both.
    - `fallbackNotFoundEnabled` covers a request that reaches a route this runtime does serve, but
      whose specific record id doesn't exist locally (`record-not-found`, see "Response envelopes"
      above).
    - Every other error type - `invalid-request`, `user-not-authenticated`,
      `cannot-remove-running-run`, `deleting-unfinished-build`, any `dev-folder-*` type,
      `internal-error` - is never relayed, regardless of either toggle's state.
- **All HTTP methods are eligible for both toggles, writes included**: a `POST`/`PUT`/`DELETE` that
  would otherwise 404/501 locally is relayed exactly like a `GET` when its toggle is on - and, if the
  platform accepts it, becomes a real write against the caller's real account. This is a deliberate
  consequence of opting in, not an oversight. An eligible request reaches the platform at most once, so
  a relayed write is never duplicated.
- **A successful relay** returns the platform's response status and body to the caller unchanged,
  marked with two response headers: `x-actor-runtime-fallback: <upstreamBaseUrl>` naming which platform
  served it, and `x-actor-runtime-fallback-trigger: unimplemented` or `record-not-found` naming which
  toggle let it through. Only a final `2xx` status counts as successful.
- **Fail-closed guarantee**: anything else - a non-`2xx` response, a timeout, or the platform being
  unreachable - reproduces the exact response the caller would have gotten with both toggles off: the
  original local error, unchanged, with neither marker header present. The platform's own status or
  body is never surfaced to the caller.
- **Only the caller's own presented token is ever forwarded.** A relayed request's `Authorization`
  header is always the exact bearer token the caller themselves sent on that request - never a
  different or runtime-internal credential, and never sent at all for a request this runtime didn't
  authenticate. Enabling either toggle therefore means the caller's own Apify token reaches the
  configured `upstreamBaseUrl` on every eligible request; this is the risk being opted into.
- **Never enriches a call that already succeeds locally**: a collection/list endpoint (e.g.
  `GET /v2/datasets`) that already returns `200` from local data never consults either toggle and never
  gains platform objects. Fallback only ever resolves an otherwise-failing request; it does not make a
  local listing "complete".
