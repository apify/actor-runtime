# actor-runtime hosted as an Apify standby Actor. Build context is this folder after `./sync.sh`,
# which copies the runtime sources into ./runtime (`apify push` uploads only this folder).
FROM node:24-bookworm-slim AS builder
WORKDIR /usr/src/app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
COPY runtime/package.json runtime/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY runtime/tsconfig.json ./
COPY runtime/src ./src
RUN pnpm run build

FROM node:24-bookworm-slim
# tar unpacks image layers; chroot (coreutils) runs them as root; proot is the fallback when not root.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends tar ca-certificates proot \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /usr/src/app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
COPY runtime/package.json runtime/pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile && pnpm store prune
COPY --from=builder /usr/src/app/dist ./dist
COPY runtime/skills ./skills

# Hosted mode also switches on by itself from APIFY_IS_AT_HOME + ACTOR_STANDBY_PORT; forced here so the
# image behaves the same under `docker run`.
ENV ACTOR_RUNTIME_HOSTED=1 \
	ACTOR_RUNTIME_DRIVER=process \
	ACTOR_RUNTIME_DATA_DIR=/data \
	ACTOR_RUNTIME_PROCESS_STORE=/var/lib/actor-runtime
RUN mkdir -p /data /var/lib/actor-runtime
CMD ["node", "dist/index.js"]
