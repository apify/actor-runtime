/** What does not work when the runtime is hosted as a standby Actor. One list, shown in the startup
 * banner, `requirements/hosted.md` and `standby-actor/README.md`. */
export const HOSTED_LIMITATIONS: readonly string[] = [
	'No container engine: Actors run as plain processes in a chroot of their unpacked image, not in containers.',
	'No per-run memory or CPU limits, no isolation between runs, and all runs share the runtime Actor’s memory, CPU, disk and network.',
	'Dockerfiles: single and multi-stage FROM/ENV/ARG/WORKDIR/USER/COPY/ADD/RUN/CMD/ENTRYPOINT only; no .dockerignore, RUN --mount, heredocs, ADD of URLs or archives, or BuildKit caching.',
	'No local dev folder (live edit without rebuild), debug mode, browser view, or migration testing.',
	'Builds and runs see /proc only under proot; the root user is required for chroot.',
	'Storages live on the runtime Actor’s disk and are lost when the run ends unless persisted (see standby-actor/README.md).',
	'Reachable only by the owning account’s token; the console needs the token once in ?token= to set a cookie.',
	'Standby limits apply: idle shutdown, platform request timeouts, and no browser access without the token.',
];
