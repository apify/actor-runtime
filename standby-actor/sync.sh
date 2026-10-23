#!/usr/bin/env bash
# Copies the runtime sources next to the Dockerfile so `apify push` (which uploads only this folder) has
# everything to build from. Run it before every push.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
rm -rf "$here/runtime"
mkdir -p "$here/runtime"
cp "$root/package.json" "$root/pnpm-lock.yaml" "$root/tsconfig.json" "$here/runtime/"
cp -r "$root/src" "$root/skills" "$here/runtime/"
echo "Synced runtime sources into $here/runtime"
