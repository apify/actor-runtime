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
- Pay-per-event charging from a run
- Result caps (`maxItems`, `maxTotalChargeUsd`)
- Ad-hoc webhooks on run start
- Run usage, cost and billing figures
- Last-run shortcuts (`runs/last`)
- Input validation against the input schema
- Encrypted secret input fields
- Actor-level default run options
- Memory bounds from `.actor/actor.json`
- Limited-permission Actors and scoped run tokens
- Running Actors from the console

## Building and publishing Actors

- Building from Git repository, archive or Gist
- Build on push (Git integration)
- Secret environment variables
- Generated per-build OpenAPI definition
- Publishing to Apify Store
- Actor monetization (rental, pay per result, pay per event)
- Deprecation and maintenance notices
- Actor README, categories and SEO metadata

## Automation and integrations

- Tasks (saved input configurations)
- Schedules
- Webhooks and webhook dispatches
- Integrations (Slack, Gmail, Drive, GitHub, Zapier, Make)
- Run notifications (email, Slack)
- Monitoring and alerting

## Storage

- Dataset export formats (CSV, XLSX, XML, HTML, RSS, JSONL)
- Dataset views, schema and item validation
- Dataset field statistics
- Bulk key-value store download (zip)
- Public and signed storage URLs
- Storage sharing (`generalAccess`)
- Storage retention and expiry
- Request queue locking and request deletion (`storage.md`)
- Storage size limits and quotas

## Account and platform

- Apify Store (browsing and running public Actors)
- Organizations, teams and member permissions
- Account usage, limits and billing
- Scoped API tokens
- Apify Proxy emulation (real proxy used when password known)
- OAuth connections for Actors
- Apify MCP server

## Console

- Input editor and run start from the console
- Run charts, usage and cost
- Storage export and download
- Account, token and billing settings
- Actor insights and analytics
- Login and per-user scoping (`console.md`)

## Inside the Actor container

- Run metadata env vars (started/timeout at, build, user)
- Input secrets private key
- Web server and Standby ports
- Log size limit and secret redaction
- Outdated SDK version warning

## Platform limits not enforced

- Memory steps and bounds (128 MB - 32 GB, powers of two)
- Record and item size limits
- Concurrent run and rate limits
- Maximum run timeout
