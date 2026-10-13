#!/usr/bin/env bash
# Installs a packed `apify-cli` tarball - `ci.yml`'s `apify-cli` job builds one from the CLI's
# `actor-runtime` branch, the unreleased CLI the runtime is developed against - into a directory of
# its own and points the e2e suite at it (`ACTOR_RUNTIME_E2E_APIFY_CLI`, `test/e2e/helpers/apify-cli.ts`),
# so every e2e job drives the runtime with that CLI rather than the one published on npm: the two are
# developed together, and this is what keeps them compatible. Local use: the same, with the export
# line printed at the end for the shell that runs the suite.
#
# Usage: install-apify-cli-package.sh <apify-cli-*.tgz> [install-dir]
#   install-dir defaults to `$RUNNER_TEMP/apify-cli` (or `$TMPDIR/apify-cli` outside Actions).
set -euo pipefail

tgz=${1:?usage: install-apify-cli-package.sh <apify-cli-*.tgz> [install-dir]}
dir=${2:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/apify-cli}
[ -f "$tgz" ] || { echo "No such file: $tgz" >&2; exit 2; }
tgz=$(cd "$(dirname "$tgz")" && pwd)/$(basename "$tgz")

# A plain npm install of the tarball as a dependency of a throwaway package: the suite runs the entry
# script straight from `node_modules/apify-cli`, exactly the files `npm install -g apify-cli` would put
# there (the package's `files`, with its dependencies resolved from npm).
rm -rf "$dir"
mkdir -p "$dir"
cd "$dir"
npm init -y >/dev/null
npm install --no-audit --no-fund --loglevel=error "$tgz"

entry=$dir/node_modules/apify-cli/dist/apify.js
[ -f "$entry" ] || { echo "The package did not install an entry script at $entry" >&2; exit 1; }
echo "Installed apify-cli $(node "$entry" --version) from $tgz"

if [ -n "${GITHUB_ENV:-}" ]; then
	echo "ACTOR_RUNTIME_E2E_APIFY_CLI=$entry" >> "$GITHUB_ENV"
else
	echo "export ACTOR_RUNTIME_E2E_APIFY_CLI=$entry"
fi
