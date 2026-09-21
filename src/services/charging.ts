/**
 * Pay-per-event charging for a run (`actor-driver.md`'s "Pay-per-event pricing" section): the
 * `POST /v2/actor-runs/:runId/charge` endpoint's logic, the synthetic `apify-default-dataset-item` event
 * the platform charges on the run's behalf for every item pushed to its default dataset, and the cost
 * cap (`options.maxTotalChargeUsd`) whose reaching gracefully aborts the run - the platform's own
 * `CostEnforcementHelper` behaviour, done inline here instead of by a daemon.
 *
 * Everything but the counts themselves is in-memory: the idempotency keys (the platform keeps them for
 * three minutes in Redis; same window here) and the default-dataset index. Both are only ever needed
 * for a live run, and a runtime restart aborts every live run anyway (`reconcileOrphanedJobs`).
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

/** How long a used idempotency key keeps answering with its first outcome - the platform's window. */
const IDEMPOTENCY_TTL_MS = 3 * 60 * 1000;

/** The platform's bound on one charge call's `count` ("to stop some joker from trying to integer overflow"). */
export const MAX_CHARGE_COUNT = 10_000_000;

interface IdempotencyEntry {
	status: number;
	expiresAt: number;
}

/** `${runId}:${idempotencyKey}` -> the status the first call answered with. */
const idempotencyRecords = new Map<string, IdempotencyEntry>();

/** Default dataset id -> run id, for the runs whose pricing defines the synthetic per-item event - the
 * only runs a dataset push has to be attributed to. Populated at run start, cleared at run end. */
const defaultDatasetRuns = new Map<string, string>();

function pruneIdempotencyRecords(now: number): void {
	for (const [key, entry] of idempotencyRecords) {
		if (entry.expiresAt <= now) idempotencyRecords.delete(key);
	}
}

export interface ChargeRequest {
	eventName: string;
	/** A positive integer, validated by the route (`1..MAX_CHARGE_COUNT`). */
	count: number;
	idempotencyKey: string;
}

/** Every way `chargeEvent` can end; the route maps each to its HTTP status and error type. */
export type ChargeResult =
	/** The charge was recorded; `status` is what the platform answers (`201`). */
	| { kind: 'charged'; status: number; run: RunRecord }
	/** The same idempotency key was already used on this run: the first call's status, no new charge. */
	| { kind: 'replayed'; status: number }
	| { kind: 'not-pay-per-event' }
	| { kind: 'apify-event' }
	| { kind: 'unknown-event' };

/**
 * Records `count` occurrences of `eventName` on the run - the whole of the charge endpoint's semantics,
 * in the platform's own order of checks: an `apify-` event is refused before anything else is looked at,
 * then the run's pricing must be pay-per-event and must define the event. Charging a finished run is
 * allowed, as on the platform (a run's last charges legitimately land as it exits); only the cost-cap
 * abort is skipped for it.
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
	// Reserved before the write lands, so a concurrent retry with the same key replays instead of
	// double-charging - the platform takes a lock for the same reason.
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

/** Remembers the run's default dataset when its pricing defines the synthetic per-item event; a no-op
 * for every other run, so pushes to their datasets cost nothing to attribute. */
export function registerDefaultDatasetForCharging(run: RunRecord): void {
	if (!isPayPerEvent(run.pricingInfo)) return;
	if (!(DEFAULT_DATASET_ITEM_EVENT_NAME in run.pricingInfo.pricingPerEvent.actorChargeEvents)) return;
	defaultDatasetRuns.set(run.defaultDatasetId, run.id);
}

export function unregisterDefaultDatasetForCharging(run: Pick<RunRecord, 'defaultDatasetId'>): void {
	defaultDatasetRuns.delete(run.defaultDatasetId);
}

/**
 * The platform's synthetic `apify-default-dataset-item` event: every item pushed to a pay-per-event
 * run's default dataset counts as one charge, with no call from the Actor (the SDKs deliberately skip
 * the charge endpoint for `apify-` events and let the platform count the writes). Called by the dataset
 * routes after every successful push; a dataset that is not a registered run's default is ignored.
 */
export async function recordDefaultDatasetItems(driver: Driver, datasetId: string, itemCount: number): Promise<void> {
	if (itemCount <= 0) return;
	const runId = defaultDatasetRuns.get(datasetId);
	if (!runId) return;
	const updated = await incrementChargedEventCount(runId, DEFAULT_DATASET_ITEM_EVENT_NAME, itemCount);
	if (updated) await enforceCostLimit(driver, updated);
}

/** Wording of the cap-reached status message and log line, shared so the console and the log agree. */
export function costLimitReachedMessage(maxTotalChargeUsd: number, chargedUsd: number): string {
	return (
		`Run aborted: the maximum total charge of $${maxTotalChargeUsd} was reached ` +
		`(charged $${chargedUsd} so far). Raise maxTotalChargeUsd to let the run charge more.`
	);
}

/**
 * The cost cap, checked after every charge (the platform's `CostEnforcementHelper.checkAndEnforceCostLimit`,
 * run inline instead of by the accounting daemon): once the run's chargeable total reaches
 * `options.maxTotalChargeUsd` (`0` or absent means no cap), `chargingStoppedAt` is stamped exactly once,
 * the run's log says why, and a `RUNNING` run is aborted gracefully with that reason as its status
 * message. Later charges are still recorded - the SDKs deliberately overshoot by one event so the
 * platform notices - but never trigger a second abort.
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

/** Test-only: drop the idempotency records and the default-dataset index. */
export function resetChargingForTests(): void {
	idempotencyRecords.clear();
	defaultDatasetRuns.clear();
}
