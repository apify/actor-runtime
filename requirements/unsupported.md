# Unsupported platform behavior

The runtime emulates the subset of the Apify platform needed for the local Actor development loop
(`system.md`'s Scope). This file lists the user-facing platform behavior that is **not supported or
emulated** at all, as short statements of intent rather than specifications. Behavior that _is_
emulated but differs from the platform in detail stays documented next to the feature it belongs to
(`storage.md`'s "Known differences from the Apify platform", `api.md`'s `501` list).

An unsupported API call answers `501`/`404` locally (`api.md`), or - with the opt-in upstream fallback
enabled - is relayed to the real platform. Relaying is not emulation: the behavior then happens in the
real account, not in the runtime.

## Running Actors

- Actor server (Actor Standby)
- Run web server and live view (`containerUrl`)
- Metamorph
- Resurrecting finished runs
- Restart on error
- Infinite runs (timeout `0`)
- Synchronous runs returning output (`run-sync`)
- Actor-set run status messages
- Result cap (`maxItems`) - the pay-per-event cost cap `maxTotalChargeUsd` is emulated (`actor-driver.md`)
- Ad-hoc webhooks on run start
- Metered usage beyond compute units: storage operations, data transfer and proxy (the run's usage fields
  estimate compute units and pay-per-event charges only, `actor-driver.md`)
- Pay-per-event accounting and billing - charges are counted and priced, never billed or paid out
- Input validation and defaults from the input schema
- Encrypted secret input fields
- Actor-level default run options
- Dynamic and bounded memory from `.actor/actor.json`
- Extra named default storages (`storageIds`)
- Limited-permission Actors and per-run scoped tokens
- Automatic run and build retention
- Running Actors from the console

## Building and publishing Actors

- Building from Git repository, archive or Gist
- Build on push (Git integration)
- Secret and build-time environment variables
- Generated per-build OpenAPI definition
- Output, key-value store and web server schemas
- Publishing to Apify Store
- Actor monetization: rental and pay per result (pay-per-event pricing is emulated for local testing,
  `actor-driver.md`), and every Store-side flow (payouts, pricing change notifications, tiers other than
  `BRONZE`)
- Actor status, deprecation and maintenance notices
- README, changelog, categories and SEO metadata

## Automation and integrations

- Tasks (saved input configurations)
- Schedules
- Webhooks and webhook dispatches
- Actor-to-Actor integrations
- Integrations (Slack, Gmail, Drive, GitHub, Zapier, Make)
- Run notifications (email, Slack)
- Monitoring and alerting
- Apify MCP server and MCP connectors

## Storage

- Dataset export formats (CSV, XLSX, XML, HTML, RSS, JSONL)
- Dataset views, schema validation and field statistics
- Key-value store schema and collections
- Bulk key-value store download (zip)
- Public and signed storage URLs
- Sharing runs and storages (`generalAccess`, access rights)
- Unnamed and shared storage listing filters
- Storage retention and expiry
- Request queue locking and request deletion (`storage.md`)

## Account and platform

- Apify Store (browsing and running public Actors)
- Actor issues, reviews and quality score
- Organizations, teams and access rights
- Account usage, limits and billing
- Multiple, scoped and expiring API tokens
- Apify Proxy emulation (real proxy used when password known)
- OAuth connections for Actors
- Legacy `/v2/acts` API paths (older clients)
- Unauthenticated reads of public resources

## Console

- Input editor and run start from the console
- Run charts (the usage and cost estimate is shown, `console.md`)
- Output tab, storage export and download
- Login, account, token and billing settings
- Actor insights, analytics and monitoring
- Per-user scoping (`console.md`)

## Inside the Actor container

- Run metadata env vars (input key, build, task, user, timestamps)
- Web server, Standby and proxy env vars
- Input secrets private key
- Log rate limiting, line truncation and size cap
- Secret redaction in logs
- Legacy `cpuInfo` events

## Platform limits not enforced

- Memory steps and bounds (128 MB - 32 GB, powers of two)
- Record, item and input size limits
- Concurrent run, rate and per-account quotas
- Process, file-descriptor and shared-memory limits
- Network isolation of Actor containers
