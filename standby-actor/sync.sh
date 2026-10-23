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
# Hidden from git through .git/info/exclude, never .gitignore: `apify push` honours .gitignore and
# would then skip the copy it is meant to upload.
exclude="$(git -C "$root" rev-parse --git-path info/exclude)"
grep -qxF 'standby-actor/runtime/' "$exclude" 2>/dev/null || echo 'standby-actor/runtime/' >> "$exclude"
echo "Synced runtime sources into $here/runtime"
