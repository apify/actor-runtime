/**
 * Pay-per-event charging for a run (`actor-driver.md`'s "Pay-per-event pricing"). The cap is enforced
 * inline after each charge, where the platform uses an accounting daemon - there is no daemon here, and
 * a local run is short enough that a delayed abort would come after it had already finished.
 *
 * Only the counts are persisted. The idempotency keys and the default-dataset index are in-memory: both
 * are only ever needed for a live run, and a restart aborts every live run anyway.
 */
import type { Driver } from '../driver/types.js';
import type { RunRecord } from '../storage/entities.js';
import { getRegistries } from '../storage/registries.js';
import { getRunTelemetry } from './events-channel.js';
import { isTerminalJobStatus } from './job-status.js';
import { appendRuntimeLog } from './logs.js';
import { APIFY_EVENTS_PREFIX, DEFAULT_DATASET_ITEM_EVENT_NAME, isPayPerEvent } from './pricing.js';
import { abortRun } from './runs.js';
import { chargeableTotalUsd, computeRunUsage } from './run-usage.js';

/** The platform's own window. */
const IDEMPOTENCY_TTL_MS = 3 * 60 * 1000;

/** The platform's own bound, there to stop an overflow attempt rather than to limit legitimate use. */
export const MAX_CHARGE_COUNT = 10_000_000;

interface IdempotencyEntry {
	status: number;
	expiresAt: number;
}

const idempotencyRecords = new Map<string, IdempotencyEntry>();

/** Only runs that price the per-item event are here, so a push to any other dataset costs one lookup. */
const defaultDatasetRuns = new Map<string, string>();

function pruneIdempotencyRecords(now: number): void {
	for (const [key, entry] of idempotencyRecords) {
		if (entry.expiresAt <= now) idempotencyRecords.delete(key);
	}
}

export interface ChargeRequest {
	eventName: string;
	count: number;
	idempotencyKey: string;
}

/** The route maps each of these to its HTTP status and error type. */
export type ChargeResult =
	| { kind: 'charged'; status: number; run: RunRecord }
	/** The key was already used on this run; answered with the first call's status, nothing charged. */
	| { kind: 'replayed'; status: number }
	| { kind: 'not-pay-per-event' }
	| { kind: 'apify-event' }
	| { kind: 'unknown-event' };

/**
 * The checks are in the platform's order, which is observable: an `apify-` event is refused before the
 * run's pricing is even looked at. Charging a finished run is allowed, since a run's last charges
 * legitimately land as it exits.
 */
export async function chargeEvent(driver: Driver, run: RunRecord, request: ChargeRequest): Promise<ChargeResult> {
	if (request.eventName.startsWith(APIFY_EVENTS_PREFIX)) return { kind: 'apify-event' };
	if (!isPayPerEvent(run.pricingInfo)) return { kind: 'not-pay-per-event' };
	if (!(request.eventName in run.pricingInfo.pricingPerEvent.actorChargeEvents)) return { kind: 'unknown-event' };

	const now = Date.now();
	pruneIdempotencyRecords(now);
	const recordKey = `${run.id}:${request.idempotencyKey}`;
	const replayed = idempotencyRecords.get(recordKey);
	if (replayed) return { kind: 'replayed', status: replayed.status };
	// Reserved before the write lands, so a concurrent retry replays instead of double-charging.
	idempotencyRecords.set(recordKey, { status: 201, expiresAt: now + IDEMPOTENCY_TTL_MS });

	let updated: RunRecord | null;
	try {
		updated = await incrementChargedEventCount(run.id, request.eventName, request.count);
	} catch (error) {
		idempotencyRecords.delete(recordKey);
		throw error;
	}
	const current = updated ?? run;
	await enforceCostLimit(driver, current);
	return { kind: 'charged', status: 201, run: current };
}

async function incrementChargedEventCount(runId: string, eventName: string, count: number): Promise<RunRecord | null> {
	return getRegistries().runs.update(runId, (current) => {
		if (!current) return current;
		const counts = { ...current.chargedEventCounts };
		counts[eventName] = (counts[eventName] ?? 0) + count;
		return { ...current, chargedEventCounts: counts };
	});
}

export function registerDefaultDatasetForCharging(run: RunRecord): void {
	if (!isPayPerEvent(run.pricingInfo)) return;
	if (!(DEFAULT_DATASET_ITEM_EVENT_NAME in run.pricingInfo.pricingPerEvent.actorChargeEvents)) return;
	defaultDatasetRuns.set(run.defaultDatasetId, run.id);
}

export function unregisterDefaultDatasetForCharging(run: Pick<RunRecord, 'defaultDatasetId'>): void {
	defaultDatasetRuns.delete(run.defaultDatasetId);
}

/**
 * Called by the dataset routes after every push, since the Actor never charges this event itself - both
 * SDKs leave `apify-` events to the platform and only count them locally.
 */
export async function recordDefaultDatasetItems(driver: Driver, datasetId: string, itemCount: number): Promise<void> {
	if (itemCount <= 0) return;
	const runId = defaultDatasetRuns.get(datasetId);
	if (!runId) return;
	const updated = await incrementChargedEventCount(runId, DEFAULT_DATASET_ITEM_EVENT_NAME, itemCount);
	if (updated) await enforceCostLimit(driver, updated);
}

export function costLimitReachedMessage(maxTotalChargeUsd: number, chargedUsd: number): string {
	return (
		`Run aborted: the maximum total charge of $${maxTotalChargeUsd} was reached ` +
		`(charged $${chargedUsd} so far). Raise maxTotalChargeUsd to let the run charge more.`
	);
}

/**
 * Stamps `chargingStoppedAt` once and aborts the run gracefully. Later charges are still recorded rather
 * than refused: both SDKs deliberately overshoot by one event at the cap so the platform notices.
 */
export async function enforceCostLimit(driver: Driver, run: RunRecord): Promise<void> {
	const cap = run.options.maxTotalChargeUsd;
	if (cap === undefined || !(cap > 0) || run.chargingStoppedAt) return;

	const total = chargeableTotalUsd(computeRunUsage(run, getRunTelemetry(run.id)), run);
	if (total < cap) return;

	const stoppedAt = new Date().toISOString();
	let stampedHere = false;
	const stamped = await getRegistries().runs.update(run.id, (current) => {
		if (!current || current.chargingStoppedAt) return current;
		stampedHere = true;
		return { ...current, chargingStoppedAt: stoppedAt };
	});
	if (!stampedHere || !stamped) return;

	const message = costLimitReachedMessage(cap, total);
	if (isTerminalJobStatus(stamped.status)) return;
	appendRuntimeLog(run.id, message);
	if (stamped.status === 'RUNNING') await abortRun(driver, stamped, true, message);
}

export function resetChargingForTests(): void {
	idempotencyRecords.clear();
	defaultDatasetRuns.clear();
}
