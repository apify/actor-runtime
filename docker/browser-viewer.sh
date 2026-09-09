#!/bin/sh
# actor-runtime's browser-view sidecar: waits for the Actor's X socket in the shared /tmp/.X11-unix, then
# mirrors that display with x11vnc. The display number is taken from the socket name (`xvfb-run -a` picks
# one at run time). When the Actor container restarts (migration), x11vnc exits and the loop waits again.
# Env names must match `src/driver/docker-driver.ts`.

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
	# -noshm: MIT-SHM cannot cross container IPC namespaces (x11vnc would die on X_ShmAttach).
	# -nosel/-nobell/-noxrecord/-nowf/-noscr: only read pixels; no clipboard, bell, or X request recording.
	# shellcheck disable=SC2086 # INPUT_FLAG is intentionally word-split.
	x11vnc -display "$display" -rfbport "$PORT" -noshm -nosel -nobell -shared -forever -nopw -noipv6 -q \
		-noxrecord -nowf -noscr $INPUT_FLAG
	log "x11vnc exited - display gone; waiting for a display again"
	sleep 1
done
