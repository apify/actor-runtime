#!/usr/bin/env bash
# Puts a container engine on the self-hosted macOS arm64 runner in `ci.yml` for the e2e suite, and takes
# it away again - a VM per job, started from nothing and deleted at the end, so every job meets a fresh
# engine and leaves none behind.
#
# Docker: the runner has no Docker of its own (Docker Desktop is the commercial product; everything here
# is the Apache-licensed engine and CLI), so each job brings the whole stack, user space, no sudo, no
# Homebrew, nothing under /usr/local or /Applications - the pieces all pinned, downloaded straight from
# their projects' releases and verified against the checksums those releases publish:
#   - Lima - runs a Linux VM on Apple's Virtualization.framework (`vz`, macOS 13+), the way Docker
#     Desktop, OrbStack and Podman's own machine do
#   - the static Docker CLI (download.docker.com), the buildx CLI plugin (the runtime's Dockerfile
#     needs BuildKit: `FROM --platform=$BUILDPLATFORM`, and Docker CLI >= 23 only builds with BuildKit
#     through this plugin), and Colima, which provisions the Docker daemon in the Lima VM
#
# Podman: installed on the runner permanently, by hand, from podman.io's installer package - the same
# install a developer has (Podman Desktop bundles that package; Homebrew builds the same pieces). It is
# only the client and the VM tooling; no VM runs until a job makes one. Each job creates its own
# `podman machine` (named `actor-runtime-e2e`, so nothing else of the runner user's is ever touched),
# rootless (`podman-rootless`, the default a developer gets) or rootful (`podman-rootful`), and removes
# it in `teardown`. That is the same Fedora CoreOS image, Virtualization.framework VM, virtiofs home
# share and Rosetta a developer's machine is, so what passes here passes on their Mac. The machine's
# state lives where Podman keeps it (`~/.local/share/containers/podman/machine`, the connections in
# `~/.config/containers`); `podman machine rm` takes all of it but the downloaded machine image, kept as
# a cache (~1 GB) so the next job's `init` is quick.
#
# The Docker stack lives under one directory, `$E2E_ENGINE_DIR` (default `$HOME/.actor-runtime-e2e`):
# the binaries, Colima's state (`COLIMA_HOME`, which also places Lima's `LIMA_HOME` under it), an
# isolated `DOCKER_CONFIG` for the docker context and the plugin, and a `tmp` dir the job's `TMPDIR` is
# pointed at (below) - used by both engines, as is the isolated `REGISTRY_AUTH_FILE` for Podman's
# Docker Hub login. `teardown` deletes the VM and that directory, plus Lima's image download cache in
# `~/Library/Caches`. The runner user's own `~/.docker`, `~/.colima` and `~/.lima` are never touched.
#
# The directory is deliberately short and directly under `$HOME`, not under `$RUNNER_TEMP`: Lima puts
# unix sockets in the instance dir (`<LIMA_HOME>/<instance>/ssh.sock.<16 digits>`), and macOS caps a
# socket path at 104 characters - the runner's `_work/_temp/...` path pushed that to 112 and Lima
# refused to start.
#
# Host directories inside the VM: `$HOME` is mounted, writable, at the same path (virtiofs) - Colima
# is told so (`--mount`), Podman's machine does it by default (`/Users`), the way Docker Desktop shares
# `/Users`. The dev-folder e2e files need it: the runtime probes the registered folder through the
# daemon's view of `/` and bind-mounts it into the Actor container, so the path must exist inside the
# VM. `TMPDIR` is pointed at `$engine_dir/tmp` for the same reason: the suite's `mkdtemp` folders
# (Node's `os.tmpdir()` honors `TMPDIR`) have to be under the mount, and macOS's per-user default
# (`/var/folders/...`) is not under `$HOME`.
#
# amd64 emulation: the Playwright sample Actors' base images have no arm64 build, so the browser-view
# files build and run them as amd64 (`build-platform.ts`'s fallback). With Rosetta on the host the VM
# gets it (Colima's `--vz-rosetta`; Podman's machine by its `containers.conf` default), which is fast
# and runs Chrome; without it the fallback is QEMU user-mode emulation in the VM (`tonistiigi/binfmt`
# for Docker, the handlers Podman's image ships), which is slow and cannot run Chrome. Installing
# Rosetta is attempted once; it may need admin rights. In Podman's machine the script also makes sure
# Rosetta, not the image's QEMU handler, is what serves amd64 binaries (`ROSETTA_IN_VM_SCRIPT`).
#
# Docker Hub: each job starts from an empty engine and pulls every base image again, and Docker Hub's
# anonymous pull limit is per IP - a day of runs on one Mac exhausts it ("toomanyrequests"). With
# `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` in the environment (the workflow passes the same repository
# secrets `release.yml` publishes with), both CLIs log in so pulls count against the account instead;
# the credentials land in the isolated `DOCKER_CONFIG` / `REGISTRY_AUTH_FILE` under the engine dir,
# never in the runner user's own config, and go with the teardown. Missing credentials only warn.
#
# The socket the runtime container gets: the suite mounts `hostEngineSocketPath()` into it - a path the
# engine resolves, so it must be the daemon's socket as seen inside the VM, where the container runs;
# the host-side forwarded sockets would not work there, a bind mount of a macOS unix socket does not
# cross into the VM. Docker: no `DOCKER_HOST`, and the suite falls back to `/var/run/docker.sock`,
# which inside the VM IS the daemon's socket; the docker CLI reaches the daemon through the context
# Colima activates (`--activate`, the default). Podman: `DOCKER_HOST` is set to what
# `podman info --format '{{.Host.RemoteSocket.Path}}'` reports - the in-VM socket, rootful
# (`/run/podman/podman.sock`) or rootless (`/run/user/<uid>/podman/podman.sock`), the very query
# `apify runtime start` makes; the podman client reaches the VM through the machine's own connection
# (`CONTAINER_CONNECTION`), which the suite never reads.
#
# Usage: macos-container-engine.sh install docker|podman-rootless|podman-rootful
#        macos-container-engine.sh teardown
#   install   sets the engine up, starts the VM, smoke-tests the socket and home mounts, and exports
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

engine_dir=${E2E_ENGINE_DIR:-$HOME/.actor-runtime-e2e}
engine_dir=${engine_dir%/}
bin_dir=$engine_dir/bin
lima_bin_dir=$engine_dir/lima/bin
tmp_dir=$engine_dir/tmp
export COLIMA_HOME=$engine_dir/colima
export DOCKER_CONFIG=$engine_dir/docker-config
export REGISTRY_AUTH_FILE=$engine_dir/podman-auth.json
# The podman machine this script makes and removes; nothing else of the runner user's Podman is touched.
PODMAN_MACHINE=actor-runtime-e2e
# Where podman.io's installer package puts the client, then Homebrew's places, in case `PATH` in the
# runner's service environment has none of them (the package adds its own through /etc/paths.d, which
# only login shells read).
PODMAN_CANDIDATES="/opt/podman/bin /usr/local/bin /opt/homebrew/bin"
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

# Most of the machine, with floors: all but 2 cores and all but 8 GiB. The runtime image build (tsc,
# pip), Actor builds, emulated browsers and the Actor runs - which the workflow gives 8 GB each, so two
# cores' worth of CPU share - all run in here; the host keeps what macOS and the runner need. The
# engines' own defaults (2 CPUs, 2-4 GiB) are far too tight for that.
vm_cpus=2
vm_memory=4
vm_size() {
	local ncpu memsize
	ncpu=$(sysctl -n hw.ncpu)
	memsize=$(sysctl -n hw.memsize)
	vm_cpus=$((ncpu - 2))
	[ "$vm_cpus" -ge 2 ] || vm_cpus=2
	vm_memory=$((memsize / 1024 / 1024 / 1024 - 8))
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

# registry_login <cli>: authenticated Docker Hub pulls, when the workflow provides credentials.
registry_login() {
	local cli=$1
	if [ -z "${DOCKERHUB_USERNAME:-}" ] || [ -z "${DOCKERHUB_TOKEN:-}" ]; then
		warn "No Docker Hub credentials (DOCKERHUB_USERNAME / DOCKERHUB_TOKEN); pulls are anonymous and count against this Mac's IP-based rate limit."
		return 0
	fi
	# docker: into $DOCKER_CONFIG/config.json. podman: into $REGISTRY_AUTH_FILE (exported to the job by
	# `export_env`), which the remote client also hands to the VM's daemon for its pulls.
	printf '%s' "$DOCKERHUB_TOKEN" | "$cli" login docker.io -u "$DOCKERHUB_USERNAME" --password-stdin ||
		die "Docker Hub login failed for '$DOCKERHUB_USERNAME'."
	echo "Logged in to Docker Hub as $DOCKERHUB_USERNAME."
}

# smoke_tests <cli> <daemon-socket-path-inside-the-vm>: the exact things the suite relies on, proven
# before it spends minutes building images, so an engine that cannot do them fails here, with a
# message that says which.
smoke_tests() {
	local cli=$1 sock=$2
	echo "::group::Check the engine"
	"$cli" version
	if [ "$cli" = podman ]; then
		"$cli" info --format 'Arch={{.Host.Arch}} OS={{.Host.Distribution.Distribution}} {{.Host.Distribution.Version}}'
	else
		"$cli" info --format 'Arch={{.Architecture}} OS={{.OperatingSystem}} Server={{.ServerVersion}}'
	fi
	# What `apify runtime start` and the suite's `runtimeRunArgs` add on a Podman host with SELinux
	# enforcing (Fedora CoreOS, as the podman machine is), and what README's "Running with Podman" tells
	# users to add: without it SELinux keeps a container from the socket mounted into it.
	# A plain string, expanded unquoted below: macOS's bash 3.2 treats an empty array expansion as an
	# unbound variable under `set -u`.
	local secopt=
	if [ "$cli" = podman ] && [ "$("$cli" info --format '{{.Host.Security.SELinuxEnabled}}' 2>/dev/null)" = true ]; then
		echo "SELinux is enabled on the engine host; containers that mount the socket get --security-opt label=disable."
		secopt="--security-opt label=disable"
	fi
	# The mount the runtime container gets: the daemon's own socket, reachable from inside a container.
	# shellcheck disable=SC2086
	"$cli" run --rm $secopt -v "$sock:/var/run/docker.sock" docker.io/library/busybox test -S /var/run/docker.sock ||
		die "$sock is not a socket inside a container on this engine; the runtime container needs it to be."
	# A host directory under $HOME, bind-mounted by its host path - what the dev-folder files do.
	mkdir -p "$tmp_dir"
	local marker="$tmp_dir/.mount-probe"
	echo ok > "$marker"
	# shellcheck disable=SC2086
	"$cli" run --rm $secopt -v "$tmp_dir:/probe" docker.io/library/busybox cat /probe/.mount-probe >/dev/null ||
		die "$tmp_dir is not visible inside the VM by its host path; the dev-folder e2e files need \$HOME shared into the VM."
	rm -f "$marker"
	# amd64 emulation, for the browser-view files. A warning, not a failure: only those files need it,
	# and their own assertions will say so if it is missing.
	if "$cli" run --rm --platform linux/amd64 docker.io/library/busybox uname -m 2>/dev/null | grep -q x86_64; then
		# Which emulator: the interpreter binfmt_misc hands the binary to is mapped into the process.
		local emulator
		emulator=$("$cli" run --rm --platform linux/amd64 docker.io/library/busybox \
			sh -c 'grep -o -m1 -E "rosetta|qemu-x86_64[a-z_-]*" /proc/self/maps' 2>/dev/null || true)
		echo "amd64 containers run on this engine (via ${emulator:-an emulator /proc/self/maps does not name})."
		case "$emulator" in
			qemu*) warn "amd64 containers run under QEMU, not Rosetta; the browser-view e2e files will fail (Chrome crashes under QEMU)." ;;
		esac
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
			echo "REGISTRY_AUTH_FILE=$REGISTRY_AUTH_FILE"
			echo "TMPDIR=$tmp_dir"
			printf '%s\n' "$@"
		} >> "$GITHUB_ENV"
	fi
	if [ -n "${GITHUB_PATH:-}" ]; then
		printf '%s\n' "$bin_dir" "$lima_bin_dir" >> "$GITHUB_PATH"
	fi
}

# export_late NAME=value...: for what is only known once the VM runs (the Podman socket path).
export_late() {
	if [ -n "${GITHUB_ENV:-}" ]; then
		printf '%s\n' "$@" >> "$GITHUB_ENV"
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
	local dl=$engine_dir/downloads
	mkdir -p "$bin_dir" "$DOCKER_CONFIG/cli-plugins" "$COLIMA_HOME" "$dl"
	install_lima "$dl"

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
	registry_login docker
	if [ -z "$rosetta" ]; then
		# QEMU user-mode handlers for foreign architectures, registered in the VM's kernel (binfmt_misc).
		docker run --privileged --rm docker.io/tonistiigi/binfmt --install amd64 ||
			warn "Could not register QEMU amd64 emulation in the VM."
	fi
	echo "::endgroup::"

	smoke_tests docker /var/run/docker.sock
	echo "Docker engine ready under $engine_dir."
}

# find_podman: the installed client, on PATH or in one of the usual install locations; its directory
# goes on the job's PATH so every later step (the suite, the log dump, `teardown`) finds the same one.
find_podman() {
	local dir
	if ! command -v podman >/dev/null 2>&1; then
		for dir in $PODMAN_CANDIDATES; do
			if [ -x "$dir/podman" ]; then
				export PATH=$dir:$PATH
				break
			fi
		done
	fi
	command -v podman >/dev/null 2>&1 ||
		die "No podman on this runner. Install it from podman.io's installer package (podman-installer-macos-arm64.pkg) as an admin; this script makes and removes the machine itself."
	dir=$(dirname "$(command -v podman)")
	if [ -n "${GITHUB_PATH:-}" ]; then
		echo "$dir" >> "$GITHUB_PATH"
	fi
	echo "Using $(command -v podman): $(podman --version)"
}

# vm_root_sh <script>: runs a shell script as root inside the podman machine, passed base64-encoded so
# no quoting has to survive two shells and ssh on the way.
vm_root_sh() {
	local encoded
	encoded=$(printf '%s' "$1" | base64 | tr -d '\n')
	podman machine ssh "$PODMAN_MACHINE" -- sudo sh -c "echo $encoded | base64 -d | sh"
}

# The Rosetta registration the machine's own activation service is supposed to make (binfmt_misc:
# x86_64 ELF magic and mask, the interpreter from the virtiofs share, `OCF` = open the interpreter at
# registration, pass credentials, fix binary).
ROSETTA_BINFMT=':rosetta:M::\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x3e\x00:\xff\xff\xff\xff\xff\xfe\xfe\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff:/mnt/rosetta/rosetta:OCF'
ROSETTA_IN_VM_SCRIPT="
bm=/proc/sys/fs/binfmt_misc
echo '--- rosetta-activation.service:' \$(systemctl is-active rosetta-activation.service 2>&1)
systemctl status --no-pager rosetta-activation.service 2>&1 | tail -n 12 || true
echo '--- rosetta mount:'; mount | grep -i rosetta || echo none
echo '--- binfmt handlers:'; ls \$bm
if [ ! -e \$bm/rosetta ] && [ -x /mnt/rosetta/rosetta ]; then
	echo 'Rosetta is mounted but not registered; registering it.'
	printf '%s' '$ROSETTA_BINFMT' > \$bm/register
fi
if [ -e \$bm/rosetta ]; then
	echo '--- rosetta handler:'; cat \$bm/rosetta
	if [ -e \$bm/qemu-x86_64 ]; then
		echo 'Removing the QEMU x86_64 handler so that Rosetta serves amd64 binaries.'
		echo -1 > \$bm/qemu-x86_64
	fi
else
	echo 'No Rosetta in this VM; amd64 binaries run under QEMU, which cannot run Chrome.'
fi
"

# install_podman rootless|rootful
install_podman() {
	local mode=$1
	# Podman keeps the machine's host-side sockets and pids under `$TMPDIR/podman`, resolved on every
	# invocation, not stored: this script and the job's later steps (which get `TMPDIR=$tmp_dir` from
	# `export_env`) must agree on it, or `podman machine rm` in `teardown` would look in the wrong
	# place and leave the VM running. Short enough for macOS's socket path cap, being under `$HOME`.
	mkdir -p "$tmp_dir"
	export TMPDIR=$tmp_dir
	find_podman
	# The machine's two connections: `<name>` as the VM's user, `<name>-root` as root. The client is
	# pinned to the one for the mode, rather than relying on which `init` makes the default.
	local connection=$PODMAN_MACHINE
	[ "$mode" = rootful ] && connection=$PODMAN_MACHINE-root
	export CONTAINER_CONNECTION=$connection
	export_env "CONTAINER_CLI=podman" "CONTAINER_CONNECTION=$connection"

	echo "::group::Create the Podman machine ($mode)"
	vm_size
	ensure_rosetta || true
	# Rosetta is a `containers.conf` setting (`[machine] rosetta`, on by default for applehv on Apple
	# silicon; Podman 6 has no `init` flag for it). Only with no Rosetta on the host is it switched off,
	# through an override file for this one command, so the machine starts and the fallback below
	# registers QEMU handlers instead.
	if [ -z "$rosetta" ]; then
		printf '[machine]\nrosetta = false\n' > "$tmp_dir/containers-no-rosetta.conf"
		export CONTAINERS_CONF_OVERRIDE=$tmp_dir/containers-no-rosetta.conf
	fi
	# `--memory` is MiB. `--disk-size` is a sparse maximum. Default mounts (`/Users`, `/private`,
	# `/var/folders`) cover `$HOME`.
	podman machine init \
		--cpus "$vm_cpus" \
		--memory "$((vm_memory * 1024))" \
		--disk-size 60 \
		$([ "$mode" = rootful ] && echo --rootful) \
		"$PODMAN_MACHINE"
	unset CONTAINERS_CONF_OVERRIDE
	podman machine start "$PODMAN_MACHINE"
	podman machine list
	podman system connection list
	podman info --format 'Connection OK: {{.Host.Hostname}} rootless={{.Host.Security.Rootless}} selinux={{.Host.Security.SELinuxEnabled}} podman={{.Version.Version}}' ||
		die "podman cannot reach the machine through connection '$connection'."
	registry_login podman
	# The in-VM socket, as `apify runtime start` resolves it for Podman; exported as `DOCKER_HOST` so
	# the suite mounts that path (see the header). Rootless: `/run/user/<uid>/podman/podman.sock`.
	local sock
	sock=$(podman info --format '{{.Host.RemoteSocket.Path}}')
	sock=${sock#unix://}
	[ -n "$sock" ] || die "podman info reports no remote socket path."
	echo "Engine socket inside the VM: $sock"
	export DOCKER_HOST="unix://$sock"
	export_late "DOCKER_HOST=$DOCKER_HOST"
	# For reading a failed socket smoke test below: the socket's SELinux label and the enforcing mode.
	podman machine ssh "$PODMAN_MACHINE" -- sh -c "getenforce; ls -laZ $(dirname "$sock")/" || true
	echo "::endgroup::"
	# The machine image ships QEMU user-mode handlers for foreign architectures, and its
	# `rosetta-activation.service` is meant to put Rosetta in front of them. Seen on this runner: the
	# service enabled, yet an amd64 Chrome ran under `qemu-x86_64-static` and crashed (QEMU cannot run
	# Chrome; Rosetta can). So, as the VM's root: register Rosetta if its share is mounted but no
	# handler exists, and drop the image's x86_64 QEMU handler whenever a Rosetta one is there, so
	# that Rosetta is the only handler for amd64 binaries. Without Rosetta the QEMU handlers stay.
	echo "::group::Rosetta in the VM"
	vm_root_sh "$ROSETTA_IN_VM_SCRIPT" || warn "Could not inspect the VM's binary-format handlers."
	echo "::endgroup::"

	smoke_tests podman "$sock"
	echo "Podman engine ready: machine $PODMAN_MACHINE ($mode)."
}

engine_install() {
	local engine=${1:-}
	case "$engine" in
		docker | podman-rootless | podman-rootful) ;;
		*) die "Usage: $0 install docker|podman-rootless|podman-rootful" ;;
	esac
	[ "$(uname -s)" = Darwin ] || die "This script is for macOS; this is $(uname -s)."
	[ "$(uname -m)" = arm64 ] || die "This script is for Apple Silicon (arm64); this is $(uname -m)."
	local macos_major
	macos_major=$(sw_vers -productVersion | cut -d. -f1)
	[ "$macos_major" -ge 13 ] || die "Virtualization.framework VMs need macOS 13 or newer; this is $(sw_vers -productVersion)."

	# A previous job that died without its teardown step (the runner losing contact with GitHub
	# mid-suite leaves the job's later steps unrun) leaves its VM running and its host agent holding the
	# forwarded ports. Stop and delete all of that first, with the binaries it left behind, rather than
	# `rm -rf` the directory from under a live VM.
	echo "Removing whatever an earlier job left behind first."
	engine_teardown
	mkdir -p "$tmp_dir"

	case "$engine" in
		docker) install_docker ;;
		podman-rootless) install_podman rootless ;;
		podman-rootful) install_podman rootful ;;
	esac
}

engine_teardown() {
	if command -v colima >/dev/null 2>&1 && [ -d "$COLIMA_HOME" ]; then
		colima stop --force 2>/dev/null || true
		colima delete --force 2>/dev/null || true
	fi
	# Lima's host agents and the ssh sessions they keep to the VMs, matched by their own names plus the
	# engine dir on their command line - Lima normally ends them; this is for a half-started VM. Not a
	# bare `pkill -f "$engine_dir"`: that also matches any shell whose command line mentions the dir.
	pkill -f "limactl.*$engine_dir" 2>/dev/null || true
	pkill -f "ssh.*$engine_dir" 2>/dev/null || true
	# The podman machine, if the client is here and the machine exists (a leftover or this job's own):
	# `rm -f` stops it first and drops its connections. Before the engine dir goes: the machine's
	# host-side sockets live under `$tmp_dir` (see `install_podman`), and `rm` needs them to stop it.
	# The machine image cache is kept, on purpose.
	local dir
	if ! command -v podman >/dev/null 2>&1; then
		for dir in $PODMAN_CANDIDATES; do
			[ -x "$dir/podman" ] && export PATH=$dir:$PATH && break
		done
	fi
	if command -v podman >/dev/null 2>&1; then
		mkdir -p "$tmp_dir"
		export TMPDIR=$tmp_dir
		if podman machine inspect "$PODMAN_MACHINE" >/dev/null 2>&1; then
			echo "Removing podman machine $PODMAN_MACHINE."
			podman machine rm -f "$PODMAN_MACHINE" || warn "Could not remove podman machine $PODMAN_MACHINE."
		fi
		# The VM and its network helper, should `rm` have lost track of them (a job killed mid-start).
		pkill -f "vfkit.*$PODMAN_MACHINE" 2>/dev/null || true
		pkill -f "gvproxy.*$PODMAN_MACHINE" 2>/dev/null || true
	fi
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
		echo "Usage: $0 install docker|podman-rootless|podman-rootful | teardown" >&2
		exit 2
		;;
esac
