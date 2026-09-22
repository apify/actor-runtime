# Using the local Actor runtime

**The usage instructions for this runtime live in [`skills/actor-runtime/SKILL.md`](./skills/actor-runtime/SKILL.md)** -
an Agent Skill, so that it travels with the runtime itself rather than only with this checkout. That
file is the single source of truth for driving the runtime; do not duplicate it here.

It ships inside the runtime image and is reachable three ways, in the order an agent should try them:

- `apify runtime skill --install` - installs it into the agent's skills directory, so it loads on
  demand in this and later sessions. Prefer this.
- `apify runtime skill` - prints it, for reading right now.
- `GET http://localhost:3333/actor-runtime/skill` - the raw file from a running runtime
  (`?format=json` for `{ name, description, content }`). Unauthenticated.

## Working on the runtime itself

Building the image from this checkout, rather than pulling it:

```bash
docker build -t actor-runtime .
mkdir -p data
docker run --rm -p 3333:3333 -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$(pwd)/data:/data" \
  actor-runtime
```

Point `apify runtime install` at a locally built image to drive it with the CLI. Podman works the
same way with its own socket path - see README.md's "Running with Podman".

The behavioural spec lives in `requirements/*.md` (`system.md`, `api.md`, `storage.md`,
`actor-driver.md`, `cli.md`, `console.md`, `test.md`; `unsupported.md` lists the platform behavior the runtime
does not emulate). When a change alters what the runtime does for
its users, update `skills/actor-runtime/SKILL.md` in the same commit - it is shipped documentation,
not a README.

## Contribution conventions

### Requirements (`requirements/*.md`)

- Describe end-user functionality.
- Describe WHAT, not HOW.
- Do not leak implementation details.
- Are concise, not verbose.

### Ad-hoc code comments

- Are concise, not verbose.
- Do not describe what the code is doing.
- Describe the missing context - why, constraints, non-obvious consequences.
- Are present only where the code is not self-explanatory.

### Pull request descriptions

- At most 5 lines.
- Concise, not verbose.
- Describe only what was done, highlighting end-user functionality.
- No implementation details, no rejected alternatives.
- No verification/testing notes.
- No agent-specific text (session links, model names, tool output).
