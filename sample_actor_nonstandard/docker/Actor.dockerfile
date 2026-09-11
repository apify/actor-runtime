# A deliberately non-standard Actor image: nothing here resembles what `apify create` produces.
#
# - A stock `python:3.11-slim` base image, not an `apify/actor-*` one - no Apify SDK, no Crawlee, no
#   pre-created `myuser`, no pre-set working directory. The Actor talks to the runtime's API with
#   nothing but the Python standard library.
# - A working directory that is neither `/usr/src/app` (the Node base images') nor `/usr/src/app`'s
#   Python equivalent - the runtime must discover it from the built image, never assume it.
# - The Actor's own non-root user, created here with an id no Apify base image uses.
# - A custom entry point: a shell script named relative to the working directory, with the Actor's
#   real command line passed as `CMD` arguments.
#
# The image reference is deliberately left short (`python:3.11-slim`, no registry): the runtime
# qualifies it itself, which is what lets the build work on Podman, whose short-name resolution would
# otherwise have to guess a registry.
FROM python:3.11-slim

# An id well outside the range Apify's own base images use, so nothing can accidentally line up.
RUN useradd --create-home --uid 1500 weirduser

WORKDIR /opt/weird-app

COPY app ./app
COPY launch.sh ./launch.sh

RUN chmod 0755 ./launch.sh && chown -R weirduser:weirduser /opt/weird-app

USER weirduser

# A working-directory-relative entry point - the file lives inside the directory a dev-folder bind
# mount covers, which is the interesting case for the runtime.
ENTRYPOINT ["./launch.sh"]
CMD ["app/main.py"]
