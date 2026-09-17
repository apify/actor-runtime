#!/usr/bin/env bash
# Puts a Docker engine on a clean macOS arm64 host for the e2e suite, and takes it away again -
# for the self-hosted runner in `ci.yml`, which has no Docker, Podman or OrbStack of its own.
#
# Everything is user space: no sudo, no Homebrew, no GUI login session, nothing under /usr/local or
# /Applications. The pieces, all pinned, all downloaded straight from their projects' releases and
# verified against the checksums those releases publish:
#   - the static Docker CLI (download.docker.com) - the `docker` the suite drives the engine with
#   - the buildx CLI plugin - the runtime's Dockerfile needs BuildKit (`FROM --platform=$BUILDPLATFORM`),
#     and Docker CLI >= 23 only builds with BuildKit through this plugin
#   - Lima + Colima - Colima runs the Docker daemon inside a Linux VM on Apple's Virtualization.framework
#     (`--vm-type vz`, macOS 13+), the engine most Docker-Desktop-less Mac developers use
#
# All of it lives under one directory, `$E2E_ENGINE_DIR` (default `$RUNNER_TEMP/actor-runtime-e2e-engine`):
# the binaries, Colima's state (`COLIMA_HOME`, which also places Lima's `LIMA_HOME` under it) and an
# isolated `DOCKER_CONFIG` for the docker context and the plugin. `teardown` deletes the VM and that
# directory, plus Lima's image download cache in `~/Library/Caches`, leaving the machine as it was found.
# The runner user's own `~/.docker`, `~/.colima` and `~/.lima` are never touched.
#
# Why no `DOCKER_HOST`: the suite mounts `hostEngineSocketPath()` into the runtime container, and with
# no `DOCKER_HOST` that is `/var/run/docker.sock` - which inside Colima's VM, where the container runs,
# IS the daemon's socket. Colima's host-side socket (`$COLIMA_HOME/default/docker.sock`) would not work
# there: a bind mount of a macOS unix socket does not cross into the VM. The CLI reaches the daemon
# through the docker context Colima activates (`--activate`, the default), which needs no env var.
#
# Usage: macos-docker-engine.sh install | teardown
#   install   downloads, verifies, starts the VM, smoke-tests the socket mount, and exports
#             E2E_ENGINE_DIR / COLIMA_HOME / DOCKER_CONFIG and the PATH additions to the job
#             (`$GITHUB_ENV` / `$GITHUB_PATH`) so every later step sees the same engine
#   teardown  stops and deletes the VM and removes everything `install` created; safe to run when
#             `install` failed halfway or never ran
set -euo pipefail

# The two entry points are `engine_install` / `engine_teardown`, not `install` / `teardown`: a bash
# function named `install` shadows /usr/bin/install, so the `install -m 0755` copies below would call
# the function itself - endless recursion, re-downloading on every round, until bash segfaults. The
# copies also say `command install` so that can never come back with a rename.
DOCKER_VERSION=29.8.1
BUILDX_VERSION=v0.37.1
LIMA_VERSION=2.2.0
COLIMA_VERSION=v0.10.3

engine_dir=${E2E_ENGINE_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/actor-runtime-e2e-engine}
engine_dir=${engine_dir%/}
bin_dir=$engine_dir/bin
lima_bin_dir=$engine_dir/lima/bin
export COLIMA_HOME=$engine_dir/colima
export DOCKER_CONFIG=$engine_dir/docker-config
export PATH=$bin_dir:$lima_bin_dir:$PATH

die() {
	echo "::error::$*" >&2
	exit 1
}

fetch() {
	# --retry covers the transient failures a GitHub release download sees; -f makes a 404 (a wrong
	# pin) fail here, with the URL, rather than as a corrupt file three steps later.
	curl -fsSL --retry 3 --retry-delay 2 -o "$2" "$1" || die "Download failed: $1"
}

# verify <file> <expected-sha256>
verify() {
	local actual
	actual=$(shasum -a 256 "$1" | cut -d' ' -f1)
	[ "$actual" = "$2" ] || die "Checksum mismatch for $1: expected $2, got $actual"
}

# sha_for <checksums-file> <asset-name>: the hash a `sha256sum`-style listing gives for one file.
sha_for() {
	awk -v name="$2" '{ f = $2; sub(/^\*/, "", f); if (f == name) { print $1; exit } }' "$1"
}

engine_install() {
	[ "$(uname -s)" = Darwin ] || die "This script is for macOS; this is $(uname -s)."
	[ "$(uname -m)" = arm64 ] || die "This script is for Apple Silicon (arm64); this is $(uname -m)."
	local macos_major
	macos_major=$(sw_vers -productVersion | cut -d. -f1)
	[ "$macos_major" -ge 13 ] || die "Colima's vz driver needs macOS 13 or newer; this is $(sw_vers -productVersion)."

	rm -rf "$engine_dir"
	mkdir -p "$bin_dir" "$DOCKER_CONFIG/cli-plugins" "$COLIMA_HOME"
	local dl=$engine_dir/downloads
	mkdir -p "$dl"

	echo "::group::Install Docker CLI $DOCKER_VERSION"
	# The static bundle is served over TLS from Docker's own host and publishes no separate checksum;
	# the daemon it will talk to is the pinned one Colima brings, not this tarball's concern.
	fetch "https://download.docker.com/mac/static/stable/aarch64/docker-$DOCKER_VERSION.tgz" "$dl/docker.tgz"
	tar -xzf "$dl/docker.tgz" -C "$dl"
	command install -m 0755 "$dl/docker/docker" "$bin_dir/docker"
	echo "::endgroup::"

	echo "::group::Install buildx $BUILDX_VERSION"
	local buildx_asset="buildx-$BUILDX_VERSION.darwin-arm64"
	local buildx_base="https://github.com/docker/buildx/releases/download/$BUILDX_VERSION"
	fetch "$buildx_base/$buildx_asset" "$dl/$buildx_asset"
	fetch "$buildx_base/checksums.txt" "$dl/buildx-checksums.txt"
	verify "$dl/$buildx_asset" "$(sha_for "$dl/buildx-checksums.txt" "$buildx_asset")"
	command install -m 0755 "$dl/$buildx_asset" "$DOCKER_CONFIG/cli-plugins/docker-buildx"
	echo "::endgroup::"

	echo "::group::Install Lima $LIMA_VERSION"
	local lima_asset="lima-$LIMA_VERSION-Darwin-arm64.tar.gz"
	local lima_base="https://github.com/lima-vm/lima/releases/download/v$LIMA_VERSION"
	fetch "$lima_base/$lima_asset" "$dl/$lima_asset"
	fetch "$lima_base/SHA256SUMS" "$dl/lima-SHA256SUMS"
	verify "$dl/$lima_asset" "$(sha_for "$dl/lima-SHA256SUMS" "$lima_asset")"
	mkdir -p "$engine_dir/lima"
	# The tarball is `bin/limactl`, `share/lima/...` at its root; `limactl` is ad-hoc signed with the
	# Virtualization entitlement by Lima's release build, which a curl download keeps (no quarantine).
	tar -xzf "$dl/$lima_asset" -C "$engine_dir/lima"
	echo "::endgroup::"

	echo "::group::Install Colima $COLIMA_VERSION"
	local colima_asset=colima-Darwin-arm64
	local colima_base="https://github.com/abiosoft/colima/releases/download/$COLIMA_VERSION"
	fetch "$colima_base/$colima_asset" "$dl/$colima_asset"
	fetch "$colima_base/$colima_asset.sha256sum" "$dl/$colima_asset.sha256sum"
	verify "$dl/$colima_asset" "$(cut -d' ' -f1 "$dl/$colima_asset.sha256sum")"
	command install -m 0755 "$dl/$colima_asset" "$bin_dir/colima"
	echo "::endgroup::"

	rm -rf "$dl"

	echo "::group::Start the Docker VM"
	# Half the machine, with a floor: the runtime image build (tsc, pip) and two Actor builds run in here,
	# and Colima's own defaults (2 CPUs, 2 GiB) are tight for that.
	local ncpu memsize cpus memory
	ncpu=$(sysctl -n hw.ncpu)
	memsize=$(sysctl -n hw.memsize)
	cpus=$((ncpu / 2))
	[ "$cpus" -ge 2 ] || cpus=2
	memory=$((memsize / 1024 / 1024 / 1024 / 2))
	[ "$memory" -ge 4 ] || memory=4
	echo "VM: $cpus CPUs, ${memory} GiB memory (host: $ncpu CPUs, $((memsize / 1024 / 1024 / 1024)) GiB)"
	# `--disk` is a sparse maximum, not an allocation. No `--vz-rosetta`: nothing in the dev-loop file
	# needs amd64 emulation; it is the switch to flip when the browser-view files join this leg. No
	# extra `--mount`: the dev-loop file bind-mounts nothing from the host (the runtime container's
	# `/data` is a named volume) - the dev-folder files would need `$TMPDIR` mounted writable.
	colima start \
		--runtime docker \
		--vm-type vz \
		--mount-type virtiofs \
		--arch aarch64 \
		--cpu "$cpus" \
		--memory "$memory" \
		--disk 60 \
		--activate \
		--verbose
	echo "::endgroup::"

	echo "::group::Check the engine"
	colima status
	[ "$(docker context show)" = colima ] || die "Colima did not activate its docker context (current: $(docker context show))."
	docker version
	docker buildx version
	docker info --format 'Arch={{.Architecture}} OS={{.OperatingSystem}} Server={{.ServerVersion}}'
	# The exact mount the suite gives the runtime container - proven before the suite spends minutes
	# building the image, so an engine that cannot do this fails here, with this message.
	docker run --rm -v /var/run/docker.sock:/var/run/docker.sock docker.io/library/busybox \
		test -S /var/run/docker.sock ||
		die "/var/run/docker.sock is not a socket inside a container on this engine; the runtime container needs it to be."
	echo "::endgroup::"

	if [ -n "${GITHUB_ENV:-}" ]; then
		{
			echo "E2E_ENGINE_DIR=$engine_dir"
			echo "COLIMA_HOME=$COLIMA_HOME"
			echo "DOCKER_CONFIG=$DOCKER_CONFIG"
		} >> "$GITHUB_ENV"
	fi
	if [ -n "${GITHUB_PATH:-}" ]; then
		printf '%s\n' "$bin_dir" "$lima_bin_dir" >> "$GITHUB_PATH"
	fi
	echo "Docker engine ready under $engine_dir."
}

engine_teardown() {
	if command -v colima >/dev/null 2>&1 && [ -d "$COLIMA_HOME" ]; then
		colima stop --force 2>/dev/null || true
		colima delete --force 2>/dev/null || true
	fi
	# Lima's host agent and the ssh sessions it keeps to the VM, matched by their own names plus Colima's
	# state dir on their command line - Colima normally ends them; this is for a half-started VM. Not a
	# bare `pkill -f "$engine_dir"`: that also matches any shell whose command line mentions the dir.
	pkill -f "limactl.*$COLIMA_HOME" 2>/dev/null || true
	pkill -f "ssh.*$COLIMA_HOME" 2>/dev/null || true
	rm -rf "$engine_dir"
	# Lima keeps the downloaded VM images here, outside LIMA_HOME. Removed for a fully clean machine; a
	# runner that stays up between jobs could keep it and skip the ~700 MB download next time.
	rm -rf "$HOME/Library/Caches/lima" "$HOME/Library/Caches/colima"
	echo "Docker engine removed."
}

case "${1:-}" in
	install) engine_install ;;
	teardown) engine_teardown ;;
	*)
		echo "Usage: $0 install | teardown" >&2
		exit 2
		;;
esac
