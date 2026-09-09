#!/bin/sh
# Entrypoint of actor-runtime's browser-view sidecar (`requirements/actor-driver.md`, "Browser view").
#
# Runs in its own container, sharing only one thing with the Actor's container: the tmpfs volume mounted
# at /tmp/.X11-unix in both, where the Actor's Xvfb creates its listening socket (`X<display>`). This
# script waits for that socket to appear, then mirrors the display over RFB (VNC) with x11vnc for the
# runtime's console to bridge to a browser. x11vnc is an ordinary X client that reads the framebuffer -
# it changes nothing about the display or the browser drawing on it, connected viewers or not.
#
# Display numbers are not known up front (the Apify base images start Xvfb through `xvfb-run -a`, which
# picks a free one at run time), so the display is discovered from the socket's own name. A restart of the
# Actor's container (a migration/reboot) tears the X server down with it; x11vnc then exits and this loop
# waits for the new socket, so the same sidecar serves the whole run.
#
# Env contract with `src/driver/docker-driver.ts` (it cannot import this file): the two variables below.

SOCKET_DIR=/tmp/.X11-unix
PORT="${APIFY_BROWSER_VIEWER_PORT:-5900}"
if [ "$APIFY_BROWSER_VIEWER_INTERACTIVE" = "1" ]; then
	INPUT_FLAG=""
	MODE=interactive
else
	INPUT_FLAG="-viewonly"
	MODE=view-only
fi

log() {
	echo "[actor-runtime browser view] $*"
}

log "waiting for an X display socket in $SOCKET_DIR (created by the Actor's own Xvfb when the Actor starts)"
while :; do
	socket=""
	for candidate in "$SOCKET_DIR"/X*; do
		if [ -S "$candidate" ]; then
			socket="$candidate"
			break
		fi
	done
	if [ -z "$socket" ]; then
		sleep 0.5
		continue
	fi

	display=":${socket##*/X}"
	log "mirroring display $display ($MODE) on port $PORT"
	# -noshm: x11vnc's default framebuffer grab is MIT-SHM, which needs a shared-memory segment the X server
	# can attach - impossible from a different container (own IPC namespace; the X server fails the attach
	# with BadAccess and x11vnc exits). Plain XGetImage over the socket works across containers.
	# -forever/-shared: stays up across viewer connect/disconnect, any number of viewers. -nopw: the port is
	# only reachable on the runtime's private Docker network. -noxrecord/-nowf/-noscr: skip x11vnc's own
	# scroll/wireframe heuristics, which are the only parts of it that go beyond plainly reading pixels.
	# shellcheck disable=SC2086 # INPUT_FLAG is intentionally word-split (empty or one flag).
	x11vnc -display "$display" -rfbport "$PORT" -noshm -shared -forever -nopw -noipv6 -q \
		-noxrecord -nowf -noscr $INPUT_FLAG
	log "x11vnc exited - the display is gone (Actor container stopped or restarting); waiting for a display again"
	sleep 1
done
