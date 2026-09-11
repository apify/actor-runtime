"""Injected via PYTHONPATH by actor-runtime's Python debug-mode payload (see actor-driver.md "Debug
mode"). CPython's `site` module imports this before any user code runs.

It runs in every Python process in the container, so it must pick exactly one to start debugpy in.
`debugpy.listen()` spawns debugpy's own adapter as a child Python that inherits PYTHONPATH and imports
this file again - unguarded, that child starts debugpy too, endlessly, and the Actor never runs. Hence
three guards, in order: an inherited env flag set before `listen()` (no filesystem, so no permissions to
lose on), a skip for processes started from inside the payload directory (the adapter), and the marker
file, which also covers siblings that inherit no flag from each other. A marker the Actor's user cannot
create (the payload directory is extracted root-owned) is not fatal - the flag already rules out the
runaway case, and a sibling that slips through fails to bind the port.

No synthetic breakpoint after wait_for_client() - the IDE's own attach decides where execution stops.
"""

import os
import sys

_PAYLOAD_DIR = os.path.dirname(os.path.abspath(__file__))
_MARKER_PATH = os.path.join(_PAYLOAD_DIR, '.debugpy-started')
_PORT_ENV_VAR = 'APIFY_ACTOR_RUNTIME_DEBUG_PORT'
# Set by this file on itself, never by the driver: "an ancestor of this process already started debugpy".
_STARTED_ENV_VAR = 'APIFY_ACTOR_RUNTIME_DEBUG_STARTED'


def _log(message):
    # Runs before the Actor's own logging exists; docker-driver.ts captures stderr into the run log.
    # The marker is the one every runtime-authored log line carries - keep it in sync with
    # `src/runtime-log.ts`.
    print(f'\033[34m[actor-runtime]\033[0m {message}', file=sys.stderr, flush=True)


def _is_payload_process() -> bool:
    """True for a process started *from* the payload directory - debugpy's adapter, never Actor code."""
    argv0 = sys.argv[0] if sys.argv else ''
    if not argv0:
        return False
    try:
        argv0 = os.path.abspath(argv0)
    except OSError:  # pragma: no cover - abspath needs the cwd, which a container run always has
        return False
    return argv0 == _PAYLOAD_DIR or argv0.startswith(_PAYLOAD_DIR + os.sep)


def _win_marker_race() -> bool:
    """True if this process should start debugpy - the exclusive create avoids a check-then-create race.
    Anything but FileExistsError falls back to "try anyway" rather than silently not debugging."""
    try:
        fd = os.open(_MARKER_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return False
    except OSError as error:
        _log(f'could not create the debugpy start-marker ({error}); trying to start debugpy anyway')
        return True
    else:
        os.close(fd)
        return True


def _should_start() -> bool:
    if os.environ.get(_STARTED_ENV_VAR):
        return False
    if _is_payload_process():
        return False
    return _win_marker_race()


def _start() -> None:
    port_raw = os.environ.get(_PORT_ENV_VAR)
    if not port_raw:
        # Driver always sets this alongside PYTHONPATH; do nothing if it's missing rather than guess a port.
        return

    try:
        port = int(port_raw)
    except ValueError:
        _log(f'internal error: {_PORT_ENV_VAR}="{port_raw}" is not an integer - not starting debugpy')
        sys.exit(1)

    try:
        import debugpy
    except Exception as error:  # pragma: no cover - the payload always ships debugpy alongside this file
        _log(f'internal error: could not import the injected debugpy ({error})')
        sys.exit(1)

    # Before listen(), not after: the adapter it spawns inherits this environment.
    os.environ[_STARTED_ENV_VAR] = '1'

    try:
        debugpy.listen(('0.0.0.0', port))
    except OSError as error:
        # A race the marker guard missed - another process likely already bound this port.
        _log(
            f'debugpy could not bind 0.0.0.0:{port} ({error}); assuming another process in this '
            'container already started it - continuing without pausing'
        )
        return
    except Exception as error:
        _log(f'internal error: debugpy.listen() failed ({error})')
        sys.exit(1)

    # The diagnosable "it's alive" signal - its absence means injection failed before printing anything.
    _log(f'debugpy is listening on 0.0.0.0:{port}, waiting for a debugger to attach')

    try:
        debugpy.wait_for_client()
    except Exception as error:
        _log(f'internal error: debugpy.wait_for_client() failed ({error})')
        sys.exit(1)

    _log('a debugger attached - continuing to the Actor\'s own first line')
    # No synthetic breakpoint - control returns to `site`'s import machinery.


if _should_start():
    _start()
