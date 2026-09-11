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

- `/actor-runtime/*` is the local-runtime-only API: the developer conveniences the Apify platform has no
  counterpart for - live dev folder, debug mode, browser view, migration emulation, upstream API
  fallback, and the per-run events channel.
- **`src/api/openapi/actor-runtime.json` is the specification for all of it**, and it is normative:
  every path, method, request body, response payload, error type and behaviour is stated there and
  deliberately not restated here. It also carries, under `x-actor-runtime-platform-notes`, what this
  runtime adds to a few otherwise faithful platform endpoints - `?devFolder=false` on run start,
  `?gracefully=` on abort, and reboot.
- The runtime serves that document at `GET /actor-runtime` (`{data}`-enveloped, so `apify api` reads it)
  and at `GET /actor-runtime/openapi.json` (bare, for OpenAPI tooling). Both are unauthenticated, so a
  client can enumerate a runtime before it holds a token (`cli.md`).
- Every endpoint in the namespace is served at both `/actor-runtime/*` and `/v2/actor-runtime/*` - the
  same routes, the second mount existing only because `apify api` builds every URL against a base that
  already ends in `/v2`. Neither mount is part of the emulated Apify API, and nothing under either is
  ever relayed upstream.
- A request under `/actor-runtime/*` that the document does not describe is answered from the document,
  never from the emulated platform surface: `404` `not-found` for an undescribed path (the message names
  `GET /actor-runtime`), `405` `method-not-allowed` with an `Allow` header for an undescribed method on a
  described path, and `426` `upgrade-required` for a plain HTTP request to the events websocket path.
- The console's own dev-folder, debug-mode and browser-view forms (`console.md`) do not go through these
  endpoints - they post to console-local, unauthenticated routes on the console's own port - but the two
  surfaces accept and reject exactly the same inputs with the same outcomes.
