#!/usr/bin/env bash
# Removes everything the e2e suite leaves on the host it ran on, so a persistent runner - the
# self-hosted macOS arm64 one in `ci.yml` - starts each job clean and leaves it clean. The hosted
# runners are ephemeral and never need this; there `stopRuntimeContainer`'s `afterAll` is enough,
# and the "Dump runtime container logs on failure" step relies on the container still being there.
# On the macOS leg the engine itself is per-job (`macos-docker-engine.sh`), so the engine-side part
# below finds little to do there; the temp dirs and the port check are what it is for on that runner.
#
# Scoped to what the suite and the runtime it drives create, nothing else on the machine:
#   - the runtime container(s) `actor-runtime-e2e*` and their `<name>-data` volumes
#     (`test/e2e/helpers/docker.ts`), which hold the fixed host ports 3333/3000
#   - Actor run, dev-folder probe and browser-viewer containers/volumes the runtime creates, found by
#     the labels `docker-driver.ts` puts on them (a runtime killed mid-run cannot clean them itself)
#   - images the runtime builds (`actor-runtime/<actor>:<buildId>`, `localhost/actor-runtime/*`) and
#     the runtime image the suite builds (`actor-runtime:e2e`), plus whatever dangling layers retagging
#     left behind. Pre-pulled base images stay: on a persistent host they are the cache that keeps the
#     job fast, and the suite re-pulls them anyway.
#   - the suite's temp dirs (`actor-runtime-e2e-*` under `$TMPDIR`, where Node's `os.tmpdir()` puts them)
#
# Usage: e2e-host-cleanup.sh [--require-free-ports]
#   --require-free-ports  fail once cleanup is done if 3333 or 3000 is still held by something this
#                         script does not own - meant for the pre-test step, where a busy port would
#                         otherwise fail `docker run` deep inside the suite with a far less clear error.
#
# Honors the suite's own engine selection: `CONTAINER_CLI=podman` drives Podman, `docker` otherwise.
set -euo pipefail

cli=${CONTAINER_CLI:-docker}
[ "$cli" = podman ] || cli=docker

require_free_ports=0
for arg in "$@"; do
	case "$arg" in
		--require-free-ports) require_free_ports=1 ;;
		*)
			echo "Unknown argument: $arg" >&2
			exit 2
			;;
	esac
done

# Whitespace-separated ids -> `$cli <cmd> -f <ids>`; a no-op on an empty list.
remove() {
	local kind=$1
	shift
	local ids
	ids=$(printf '%s\n' "$@" | sed '/^$/d' | sort -u)
	[ -n "$ids" ] || return 0
	echo "Removing $kind:"
	printf '  %s\n' $ids
	# shellcheck disable=SC2086
	"$cli" "$kind" rm -f $ids >/dev/null || true
}

if ! "$cli" info >/dev/null 2>&1; then
	echo "::warning::$cli daemon is not reachable; nothing to clean up on the engine side (the suite itself will fail on this)."
else
	remove container \
		"$("$cli" ps -aq --filter name=actor-runtime-e2e)" \
		"$("$cli" ps -aq --filter label=actor-runtime.runId)" \
		"$("$cli" ps -aq --filter label=actor-runtime.devFolderProbe)" \
		"$("$cli" ps -aq --filter label=actor-runtime.browserViewer)"

	remove volume \
		"$("$cli" volume ls -q --filter name=actor-runtime-e2e)" \
		"$("$cli" volume ls -q --filter label=actor-runtime.browserViewer)"

	remove image \
		"$("$cli" images -q --filter reference='actor-runtime:e2e')" \
		"$("$cli" images -q --filter reference='actor-runtime/*')" \
		"$("$cli" images -q --filter reference='localhost/actor-runtime/*')"

	# Only dangling (untagged, unreferenced) layers - retagging `actor-runtime:e2e` on every run leaves
	# the previous image behind as one, and they add up on a machine that is never recreated.
	"$cli" image prune -f >/dev/null || true
fi

# `os.tmpdir()` in Node: `$TMPDIR` if set (macOS sets it per user, to a `/var/folders/...` path),
# `/tmp` otherwise - the same rule as here, so the glob lands where the suite's `mkdtemp` calls did.
tmp=${TMPDIR:-/tmp}
tmp=${tmp%/}
shopt -s nullglob
leftovers=("$tmp"/actor-runtime-e2e-*)
shopt -u nullglob
if [ ${#leftovers[@]} -gt 0 ]; then
	echo "Removing temp dirs:"
	printf '  %s\n' "${leftovers[@]}"
	rm -rf "${leftovers[@]}"
fi

if [ "$require_free_ports" -eq 1 ]; then
	if ! command -v lsof >/dev/null 2>&1; then
		echo "::warning::lsof not found; cannot verify that ports 3333 and 3000 are free."
		exit 0
	fi
	busy=0
	for port in 3333 3000; do
		# `docker run -p` binds these on the host; anything still listening now is not ours to remove.
		if holders=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null) && [ -n "$holders" ]; then
			echo "::error::Port $port is still in use after cleanup - the e2e runtime container needs it:"
			echo "$holders"
			busy=1
		fi
	done
	[ "$busy" -eq 0 ] || exit 1
fi

echo "e2e host cleanup done."
