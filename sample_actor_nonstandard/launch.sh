#!/bin/sh
# The Actor's custom entry point. Prints enough about the environment it was started in for the e2e
# suite to assert on it (working directory, user, the entry point's own resolved path), then hands
# over to the Actor itself with whatever arguments `CMD` supplied.
set -eu

echo "launch.sh: entry point running as $0"
echo "launch.sh: working directory $(pwd)"
echo "launch.sh: user id $(id -u)"
echo "launch.sh: handing over to: $*"

exec python3 -u "$@"
