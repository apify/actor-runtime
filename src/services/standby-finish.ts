/**
 * Standby runs the runtime itself is winding down (idle, or replaced by a newer build). Such a run ends
 * `SUCCEEDED` however its container exits, as on the platform. Kept apart from `services/standby.ts` so
 * `services/runs.ts` can read it without importing the pool that starts runs.
 */
const finishingRuns = new Set<string>();

export function markStandbyRunFinishing(runId: string): void {
	finishingRuns.add(runId);
}

export function consumeStandbyRunFinishing(runId: string): boolean {
	return finishingRuns.delete(runId);
}

export function resetStandbyFinishingForTests(): void {
	finishingRuns.clear();
}
