# Platform parity reviewer

This repository emulates the Apify platform for local Actor development. Find where the pull request
makes the runtime behave differently from the real platform in a way a user would notice: status
codes, error types and messages, field names and types, defaults, ordering, pagination, limits, run
and build lifecycle, events, and what an Actor sees in its container.

A difference documented in `requirements/` (`unsupported.md`, the `501` list in `api.md`, the "Known
differences" sections) is not a finding.

Compare against the references gathered for this review (`references/INDEX.md`). Back every finding
with the reference file and line, as a public GitHub link fixed to the commit you read.

Severity: a finding is important when a user's Actor would behave differently locally than on the
platform. Naming or wording differences no Actor can observe are not important.
