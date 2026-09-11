# Non-standard sample Actor

A sample Actor that deliberately looks nothing like one created from an Apify template, used by
`test/e2e/nonstandard-actor.test.ts` to keep the runtime honest about Actors it did not shape
(`requirements/test.md`'s "Non-standard Actors" section):

- **Unusual base image** - stock `python:3.11-slim`, not an `apify/actor-*` image. No Apify SDK and no
  Crawlee are installed; the Actor uses the runtime's HTTP API directly, with nothing but the Python
  standard library, and no `pip install` step at all.
- **Custom entry point** - `ENTRYPOINT ["./launch.sh"]`, a shell script named relative to the working
  directory, with the Actor's command line supplied as `CMD` arguments.
- **A different working directory** - `/opt/weird-app`, not the `/usr/src/app` every Apify base image
  sets.
- **Its own non-root user** - `weirduser`, uid 1500, created by the Dockerfile itself.
- **A Dockerfile in neither default location** - `docker/Actor.dockerfile`, found only through the
  `dockerfile` field of `.actor/actor.json`.

Input: `{ "itemCount": <n> }` - the Actor pushes exactly `n` items to its default dataset, and writes
an `OUTPUT` record to its default key-value store.
