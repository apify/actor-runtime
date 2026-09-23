# Standby sample Actor

An Actor server for trying Actor Standby against the local runtime. `.actor/actor.json` sets
`usesStandbyMode`, so `apify push` enables Standby for the Actor.

```bash
apify push
curl "http://localhost:3333/actor-runtime/standby/<username>--my-standby-actor/hello?name=Ada&token=<token>"
```

The first request starts a standby run; later ones reuse it. Each request pushes one item to that run's
default dataset. After `idleTimeoutSecs` (300 by default) without requests the run is wound down and
ends `SUCCEEDED`; the next request starts a fresh one. `apify call` starts an ordinary run instead,
which says where to send requests and exits.
