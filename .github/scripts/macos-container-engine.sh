#!/usr/bin/env bash
# Puts a container engine on a clean macOS arm64 host for the e2e suite, and takes it away again -
# for the self-hosted runner in `ci.yml`, which has no Docker, Podman or OrbStack of its own.
#
# Everything is user space: no sudo, no Homebrew, no GUI login session, nothing under /usr/local or
# /Applications. The pieces, all pinned, all downloaded straight from their projects' releases and
# verified against the checksums those releases publish:
#   - Lima - runs a Linux VM on Apple's Virtualization.framework (`vz`, macOS 13+); both engines live in
#     one such VM, which is also how Docker Desktop, OrbStack and Podman Desktop work on a Mac
#   - `docker`: the static Docker CLI (download.docker.com), the buildx CLI plugin (the runtime's
#     Dockerfile needs BuildKit: `FROM --platform=$BUILDPLATFORM`, and Docker CLI >= 23 only builds with
#     BuildKit through this plugin), and Colima, which provisions the Docker daemon in the Lima VM
#   - `podman`: the podman remote client (containers/podman's `podman-remote-release-darwin_arm64.zip`)
#     talking to Lima's own `podman-rootful` template - Fedora's current Podman, its API socket at
#     `/run/podman/podman.sock` inside the VM, forwarded to a host socket the client is pointed at
#
# All of it lives under one directory, `$E2E_ENGINE_DIR` (default `$HOME/.actor-runtime-e2e`): the
# binaries, Colima's state (`COLIMA_HOME`, which also places Lima's `LIMA_HOME` under it), the Podman
# instance's `LIMA_HOME`, an isolated `DOCKER_CONFIG` for the docker context and the plugin, and a
# `tmp` dir the job's `TMPDIR` is pointed at (below). `teardown` deletes the VM and that directory,
# plus Lima's image download cache in `~/Library/Caches`, leaving the machine as it was found. The
# runner user's own `~/.docker`, `~/.colima`, `~/.lima` and `~/.config/containers` are never touched.
#
# The directory is deliberately short and directly under `$HOME`, not under `$RUNNER_TEMP`: Lima puts
# unix sockets in the instance dir (`<LIMA_HOME>/<instance>/ssh.sock.<16 digits>`), and macOS caps a
# socket path at 104 characters - the runner's `_work/_temp/...` path pushed that to 112 and Lima
# refused to start.
#
# Host directories inside the VM: `$HOME` is mounted, writable, at the same path (virtiofs) - the way
# Docker Desktop shares `/Users` by default. The dev-folder e2e files need it: the runtime probes the
# registered folder through the daemon's view of `/` and bind-mounts it into the Actor container, so
# the path must exist inside the VM. `TMPDIR` is pointed at `$engine_dir/tmp` for the same reason:
# the suite's `mkdtemp` folders (Node's `os.tmpdir()` honors `TMPDIR`) have to be under the mount,
# and macOS's per-user default (`/var/folders/...`) is not.
#
# amd64 emulation: the Playwright sample Actors' base images have no arm64 build, so the browser-view
# files build and run them as amd64 (`build-platform.ts`'s fallback). With Rosetta on the host the VM
# gets it (`--vz-rosetta` / `--rosetta`), which is fast; without it the fallback is QEMU user-mode
# emulation registered in the VM (`tonistiigi/binfmt` for Docker, `qemu-user-static` for Podman),
# which is slow but works. Installing Rosetta is attempted once; it may need admin rights.
#
# Why no `DOCKER_HOST`: the suite mounts `hostEngineSocketPath()` into the runtime container, and with
# no `DOCKER_HOST` that is `/var/run/docker.sock` (docker) or `/run/podman/podman.sock` (podman) -
# which inside the VM, where the container runs, IS the daemon's socket. The host-side forwarded
# sockets would not work there: a bind mount of a macOS unix socket does not cross into the VM. The
# CLIs reach the daemon another way: the docker context Colima activates (`--activate`, the default),
# and `CONTAINER_HOST` for the podman remote client - neither is read by the suite.
#
# Usage: macos-container-engine.sh install docker|podman
#        macos-container-engine.sh teardown
#   install   downloads, verifies, starts the VM, smoke-tests the socket and home mounts, and exports
#             the engine's env (`CONTAINER_CLI`, `TMPDIR`, ...) and PATH additions to the job
#             (`$GITHUB_ENV` / `$GITHUB_PATH`) so every later step sees the same engine
#   teardown  stops and deletes whichever VM exists and removes everything `install` created; safe to
#             run when `install` failed halfway or never ran
set -euo pipefail

# The two entry points are `engine_install` / `engine_teardown`, not `install` / `teardown`: a bash
# function named `install` shadows /usr/bin/install, so the `install -m 0755` copies below would call
# the function itself - endless recursion, re-downloading on every round, until bash segfaults. The
# copies also say `command install` so that can never come back with a rename.
DOCKER_VERSION=29.8.1
BUILDX_VERSION=v0.37.1
LIMA_VERSION=2.2.0
COLIMA_VERSION=v0.10.3
PODMAN_VERSION=v6.1.2

engine_dir=${E2E_ENGINE_DIR:-$HOME/.actor-runtime-e2e}
engine_dir=${engine_dir%/}
bin_dir=$engine_dir/bin
lima_bin_dir=$engine_dir/lima/bin
tmp_dir=$engine_dir/tmp
export COLIMA_HOME=$engine_dir/colima
export DOCKER_CONFIG=$engine_dir/docker-config
# Lima home for the standalone (podman) instance. Colima ignores it and uses `$COLIMA_HOME/_lima`.
podman_lima_home=$engine_dir/limahome
PODMAN_INSTANCE=podman
export PATH=$bin_dir:$lima_bin_dir:$PATH

die() {
	echo "::error::$*" >&2
	exit 1
}

warn() {
	echo "::warning::$*" >&2
}

fetch() {
	# --retry covers the transient failures a GitHub release download sees; -f makes a 404 (a wrong
	# pin) fail here, with the URL, rather than as a corrupt file three steps later.
	curl -fsSL --retry 3 --retry-delay 2 -o "$2" "$1" || die "Download failed: $1"
}

# verify <file> <expected-sha256>
verify() {
	[ -n "$2" ] || die "No published checksum found for $1 - the release's checksum list does not name this asset."
	local actual
	actual=$(shasum -a 256 "$1" | cut -d' ' -f1)
	[ "$actual" = "$2" ] || die "Checksum mismatch for $1: expected $2, got $actual"
}

# sha_for <checksums-file> <asset-name>: the hash a `sha256sum`-style listing gives for one file.
sha_for() {
	awk -v name="$2" '{ f = $2; sub(/^\*/, "", f); if (f == name) { print $1; exit } }' "$1"
}

# Half the machine, with a floor: the runtime image build (tsc, pip), Actor builds and emulated
# browsers run in here, and the engines' own defaults (2 CPUs, 2-4 GiB) are tight for that.
vm_cpus=2
vm_memory=4
vm_size() {
	local ncpu memsize
	ncpu=$(sysctl -n hw.ncpu)
	memsize=$(sysctl -n hw.memsize)
	vm_cpus=$((ncpu / 2))
	[ "$vm_cpus" -ge 2 ] || vm_cpus=2
	vm_memory=$((memsize / 1024 / 1024 / 1024 / 2))
	[ "$vm_memory" -ge 4 ] || vm_memory=4
	echo "VM: $vm_cpus CPUs, ${vm_memory} GiB memory (host: $ncpu CPUs, $((memsize / 1024 / 1024 / 1024)) GiB)"
}

# `arch -x86_64` can only run a binary when Rosetta is installed - the most direct test there is.
rosetta_available() {
	/usr/bin/arch -x86_64 /usr/bin/true 2>/dev/null
}

# Sets `rosetta=1` when Rosetta is (or could just now be) installed, `rosetta=` otherwise.
rosetta=
ensure_rosetta() {
	if rosetta_available; then
		echo "Rosetta is installed; the VM gets it for amd64 containers."
		rosetta=1
		return 0
	fi
	echo "Rosetta is not installed; trying to install it (this may need admin rights and then fail)..."
	if /usr/sbin/softwareupdate --install-rosetta --agree-to-license >/dev/null 2>&1 && rosetta_available; then
		echo "Rosetta installed."
		rosetta=1
		return 0
	fi
	warn "Rosetta is not available on this Mac; amd64 Actor images (the Playwright samples) will run under QEMU emulation, which is much slower."
	rosetta=
}

# smoke_tests <cli> <daemon-socket-path-inside-the-vm>: the exact things the suite relies on, proven
# before it spends minutes building images, so an engine that cannot do them fails here, with a
# message that says which.
smoke_tests() {
	local cli=$1 sock=$2
	echo "::group::Check the engine"
	"$cli" version
	"$cli" info --format 'Arch={{.Host.Arch}} OS={{.Host.Distribution.Distribution}}' 2>/dev/null ||
		"$cli" info --format 'Arch={{.Architecture}} OS={{.OperatingSystem}} Server={{.ServerVersion}}'
	# The mount the runtime container gets: the daemon's own socket, reachable from inside a container.
	"$cli" run --rm -v "$sock:/var/run/docker.sock" docker.io/library/busybox test -S /var/run/docker.sock ||
		die "$sock is not a socket inside a container on this engine; the runtime container needs it to be."
	# A host directory under $HOME, bind-mounted by its host path - what the dev-folder files do.
	mkdir -p "$tmp_dir"
	local marker="$tmp_dir/.mount-probe"
	echo ok > "$marker"
	"$cli" run --rm -v "$tmp_dir:/probe" docker.io/library/busybox cat /probe/.mount-probe >/dev/null ||
		die "$tmp_dir is not visible inside the VM by its host path; the dev-folder e2e files need \$HOME shared into the VM."
	rm -f "$marker"
	# amd64 emulation, for the browser-view files. A warning, not a failure: only those files need it,
	# and their own assertions will say so if it is missing.
	if "$cli" run --rm --platform linux/amd64 docker.io/library/busybox uname -m 2>/dev/null | grep -q x86_64; then
		echo "amd64 containers run on this engine."
	else
		warn "amd64 containers do not run on this engine; the browser-view e2e files will fail."
	fi
	echo "::endgroup::"
}

export_env() {
	# Exported before the VM start, not after: the workflow's later steps (the log dump on failure,
	# `teardown`) need the CLIs on their PATH even when the start fails.
	mkdir -p "$tmp_dir"
	if [ -n "${GITHUB_ENV:-}" ]; then
		{
			echo "E2E_ENGINE_DIR=$engine_dir"
			echo "COLIMA_HOME=$COLIMA_HOME"
			echo "DOCKER_CONFIG=$DOCKER_CONFIG"
			echo "TMPDIR=$tmp_dir"
			printf '%s\n' "$@"
		} >> "$GITHUB_ENV"
	fi
	if [ -n "${GITHUB_PATH:-}" ]; then
		printf '%s\n' "$bin_dir" "$lima_bin_dir" >> "$GITHUB_PATH"
	fi
}

install_lima() {
	echo "::group::Install Lima $LIMA_VERSION"
	local dl=$1
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
}

install_docker() {
	local dl=$1

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
	# `checksums-signed.txt`, not `checksums.txt`: buildx code-signs its darwin and windows binaries after
	# the main list is written, so only the signed list names them.
	fetch "$buildx_base/checksums-signed.txt" "$dl/buildx-checksums.txt"
	verify "$dl/$buildx_asset" "$(sha_for "$dl/buildx-checksums.txt" "$buildx_asset")"
	command install -m 0755 "$dl/$buildx_asset" "$DOCKER_CONFIG/cli-plugins/docker-buildx"
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
	export_env "CONTAINER_CLI=docker"

	echo "::group::Start the Docker VM"
	vm_size
	ensure_rosetta || true
	# `--disk` is a sparse maximum, not an allocation. `--mount` replaces Colima's default mounts
	# (`$HOME` read-only-ish and `/tmp/colima`) with the one the suite needs, writable.
	colima start \
		--runtime docker \
		--vm-type vz \
		--mount-type virtiofs \
		--arch aarch64 \
		--cpu "$vm_cpus" \
		--memory "$vm_memory" \
		--disk 60 \
		--mount "$HOME:w" \
		${rosetta:+--vz-rosetta} \
		--activate \
		--verbose
	colima status
	[ "$(docker context show)" = colima ] || die "Colima did not activate its docker context (current: $(docker context show))."
	docker buildx version
	if [ -z "$rosetta" ]; then
		# QEMU user-mode handlers for foreign architectures, registered in the VM's kernel (binfmt_misc).
		docker run --privileged --rm docker.io/tonistiigi/binfmt --install amd64 ||
			warn "Could not register QEMU amd64 emulation in the VM."
	fi
	echo "::endgroup::"

	smoke_tests docker /var/run/docker.sock
	echo "Docker engine ready under $engine_dir."
}

install_podman() {
	local dl=$1

	echo "::group::Install podman remote client $PODMAN_VERSION"
	local podman_asset=podman-remote-release-darwin_arm64.zip
	local podman_base="https://github.com/containers/podman/releases/download/$PODMAN_VERSION"
	fetch "$podman_base/$podman_asset" "$dl/$podman_asset"
	fetch "$podman_base/shasums" "$dl/podman-shasums"
	verify "$dl/$podman_asset" "$(sha_for "$dl/podman-shasums" "$podman_asset")"
	mkdir -p "$dl/podman"
	unzip -q "$dl/$podman_asset" -d "$dl/podman"
	# The zip unpacks to `podman-<version>/usr/bin/podman` (plus docs and the mac helper, unused here).
	local podman_bin
	podman_bin=$(find "$dl/podman" -type f -name podman -path '*/bin/*' | head -n 1)
	[ -n "$podman_bin" ] || die "The podman remote client zip contains no bin/podman."
	command install -m 0755 "$podman_bin" "$bin_dir/podman"
	echo "::endgroup::"

	rm -rf "$dl"
	export LIMA_HOME=$podman_lima_home
	mkdir -p "$LIMA_HOME"
	local sock="$LIMA_HOME/$PODMAN_INSTANCE/sock/podman.sock"
	export CONTAINER_HOST="unix://$sock"
	export_env "CONTAINER_CLI=podman" "LIMA_HOME=$LIMA_HOME" "CONTAINER_HOST=$CONTAINER_HOST"

	echo "::group::Start the Podman VM"
	vm_size
	ensure_rosetta || true
	# Lima's own template: Fedora with Podman from dnf, rootful, `podman.socket` on
	# `/run/podman/podman.sock`, forwarded to `<instance dir>/sock/podman.sock` on the host.
	# `--mount-writable` turns the template's default read-only `~` mount writable. `--tty=false`: no
	# interactive "proceed with this configuration?" prompt.
	limactl start \
		--tty=false \
		--name="$PODMAN_INSTANCE" \
		--vm-type vz \
		--mount-type virtiofs \
		--mount-writable \
		--cpus "$vm_cpus" \
		--memory "$vm_memory" \
		--disk 60 \
		${rosetta:+--rosetta} \
		template://podman-rootful
	limactl list
	# The socket forward is set up by Lima's host agent once the guest socket exists; give it a moment.
	local i
	for i in $(seq 1 60); do
		[ -S "$sock" ] && podman info >/dev/null 2>&1 && break
		sleep 1
	done
	podman info >/dev/null || die "podman cannot reach the VM's API socket through $sock."
	if [ -z "$rosetta" ]; then
		limactl shell "$PODMAN_INSTANCE" sudo dnf install -y qemu-user-static-x86 ||
			warn "Could not install QEMU amd64 emulation in the VM."
	fi
	echo "::endgroup::"

	smoke_tests podman /run/podman/podman.sock
	echo "Podman engine ready under $engine_dir."
}

engine_install() {
	local engine=${1:-}
	case "$engine" in
		docker | podman) ;;
		*) die "Usage: $0 install docker|podman" ;;
	esac
	[ "$(uname -s)" = Darwin ] || die "This script is for macOS; this is $(uname -s)."
	[ "$(uname -m)" = arm64 ] || die "This script is for Apple Silicon (arm64); this is $(uname -m)."
	local macos_major
	macos_major=$(sw_vers -productVersion | cut -d. -f1)
	[ "$macos_major" -ge 13 ] || die "Lima's vz driver needs macOS 13 or newer; this is $(sw_vers -productVersion)."

	rm -rf "$engine_dir"
	mkdir -p "$bin_dir" "$DOCKER_CONFIG/cli-plugins" "$COLIMA_HOME" "$tmp_dir"
	local dl=$engine_dir/downloads
	mkdir -p "$dl"

	install_lima "$dl"
	"install_$engine" "$dl"
}

engine_teardown() {
	if command -v colima >/dev/null 2>&1 && [ -d "$COLIMA_HOME" ]; then
		colima stop --force 2>/dev/null || true
		colima delete --force 2>/dev/null || true
	fi
	if command -v limactl >/dev/null 2>&1 && [ -d "$podman_lima_home/$PODMAN_INSTANCE" ]; then
		LIMA_HOME=$podman_lima_home limactl stop --tty=false --force "$PODMAN_INSTANCE" 2>/dev/null || true
		LIMA_HOME=$podman_lima_home limactl delete --tty=false --force "$PODMAN_INSTANCE" 2>/dev/null || true
	fi
	# Lima's host agents and the ssh sessions they keep to the VMs, matched by their own names plus the
	# engine dir on their command line - Lima normally ends them; this is for a half-started VM. Not a
	# bare `pkill -f "$engine_dir"`: that also matches any shell whose command line mentions the dir.
	pkill -f "limactl.*$engine_dir" 2>/dev/null || true
	pkill -f "ssh.*$engine_dir" 2>/dev/null || true
	rm -rf "$engine_dir"
	# Lima keeps the downloaded VM images here, outside LIMA_HOME. Removed for a fully clean machine; a
	# runner that stays up between jobs could keep it and skip the ~700 MB download next time.
	rm -rf "$HOME/Library/Caches/lima" "$HOME/Library/Caches/colima"
	echo "Container engine removed."
}

case "${1:-}" in
	install) engine_install "${2:-}" ;;
	teardown) engine_teardown ;;
	*)
		echo "Usage: $0 install docker|podman | teardown" >&2
		exit 2
		;;
esac
