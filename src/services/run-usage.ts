/**
 * The run's cost estimate (`actor-driver.md`'s "Run usage estimate"): the platform's `stats`, `usage`,
 * `usageUsd`, `eventUsage` and `usageTotalUsd` run fields, computed from what this runtime can actually
 * measure - the run's memory grant and wall-clock time (compute units), the sampled CPU/memory telemetry,
 * and the pay-per-event charges recorded on the run. Everything else the platform meters (storage
 * operations, data transfer, proxy) is not counted, so `usage` carries only `ACTOR_COMPUTE_UNITS`.
 *
 * Prices are the lowest paid subscription tier's (the Starter plan, tier BRONZE): $0.20 per compute unit
 * at the time of writing (https://apify.com/pricing). The free plan lists the same figure, so the number
 * is the one a developer testing an Actor would see either way.
 *
 * Pure: the caller passes the run record, the live telemetry (if any) and `now`.
 */
import type { RunRecord } from '../storage/entities.js';
import type { RunTelemetrySnapshot } from './events-channel.js';
import { isPayPerEvent } from './pricing.js';

/** One compute unit is 1 GB of memory for one hour, the platform's own definition. */
export const COMPUTE_UNIT_MBYTES = 1024;
export const COMPUTE_UNIT_MILLIS = 60 * 60 * 1000;

/** The Starter plan's price per compute unit, in USD. */
export const STARTER_PLAN_COMPUTE_UNIT_PRICE_USD = 0.2;

/** The chargeable service this runtime meters; the key is the platform's own enum value. */
export const ACTOR_COMPUTE_UNITS = 'ACTOR_COMPUTE_UNITS';

/** Cost figures are USD; the platform rounds to 6 decimals in billing (`BILLING_ROUND_DECIMALS`). */
const USD_DECIMALS = 6;

export function roundUsd(value: number): number {
	return Number(value.toFixed(USD_DECIMALS));
}

export interface RunUsageStats {
	inputBodyLen: number;
	migrationCount: number;
	rebootCount: number;
	restartCount: number;
	resurrectCount: number;
	durationMillis: number;
	runTimeSecs: number;
	metamorph: number;
	computeUnits: number;
	memAvgBytes?: number;
	memMaxBytes?: number;
	memCurrentBytes?: number;
	cpuAvgUsage?: number;
	cpuMaxUsage?: number;
	cpuCurrentUsage?: number;
}

export interface RunEventUsage {
	[eventName: string]: { eventTitle: string; eventTotalUsd: number };
}

export interface RunUsage {
	stats: RunUsageStats;
	usage: { [ACTOR_COMPUTE_UNITS]: number };
	usageUsd: { [ACTOR_COMPUTE_UNITS]: number };
	/** Per-event totals; present only on a pay-per-event run. */
	eventUsage?: RunEventUsage;
	/** Platform usage USD plus event USD - everything the runtime can price for this run. */
	usageTotalUsd: number;
	/** The two components of `usageTotalUsd`, for the console's breakdown. */
	platformUsageUsd: number;
	eventsUsd: number;
}

/** Wall-clock milliseconds the run has been going: creation to `finishedAt`, or to `now` while live. A
 * `READY` run that never started counts as `0` - there is no container yet. */
export function runDurationMillis(run: Pick<RunRecord, 'status' | 'startedAt' | 'finishedAt'>, now: Date): number {
	if (run.status === 'READY') return 0;
	const endMillis = run.finishedAt ? Date.parse(run.finishedAt) : now.getTime();
	return Math.max(0, endMillis - Date.parse(run.startedAt));
}

export function computeUnitsFor(memoryMbytes: number, durationMillis: number): number {
	return (memoryMbytes / COMPUTE_UNIT_MBYTES) * (durationMillis / COMPUTE_UNIT_MILLIS);
}

/** Every priced event, at count times price - the platform's `getEventUsage` without resurrection
 * snapshots (which this runtime never produces). An event charged but no longer priced is skipped, the
 * platform's own rule. */
export function eventUsageFor(run: Pick<RunRecord, 'pricingInfo' | 'chargedEventCounts'>): RunEventUsage | undefined {
	if (!isPayPerEvent(run.pricingInfo)) return undefined;
	const usage: RunEventUsage = {};
	for (const [eventName, event] of Object.entries(run.pricingInfo.pricingPerEvent.actorChargeEvents)) {
		const count = run.chargedEventCounts?.[eventName] ?? 0;
		usage[eventName] = { eventTitle: event.eventTitle, eventTotalUsd: roundUsd(count * event.eventPriceUsd) };
	}
	return usage;
}

export function sumEventUsageUsd(eventUsage: RunEventUsage | undefined): number {
	let total = 0;
	for (const { eventTotalUsd } of Object.values(eventUsage ?? {})) total += eventTotalUsd;
	return roundUsd(total);
}

/**
 * The full estimate for one run. `telemetry` is the live in-memory snapshot for a run still going, or
 * `undefined` - the persisted `run.stats` figures (written when the run ended) are used then.
 */
export function computeRunUsage(
	run: RunRecord,
	telemetry: RunTelemetrySnapshot | undefined,
	now = new Date(),
): RunUsage {
	const durationMillis = runDurationMillis(run, now);
	const computeUnits = computeUnitsFor(run.options.memoryMbytes, durationMillis);
	const persisted = run.stats ?? {};
	const measured: Partial<RunTelemetrySnapshot> = telemetry ?? {
		memAvgBytes: persisted.memAvgBytes,
		memMaxBytes: persisted.memMaxBytes,
		memCurrentBytes: persisted.memCurrentBytes,
		cpuAvgUsage: persisted.cpuAvgUsage,
		cpuMaxUsage: persisted.cpuMaxUsage,
		cpuCurrentUsage: persisted.cpuCurrentUsage,
	};

	const stats: RunUsageStats = {
		inputBodyLen: persisted.inputBodyLen ?? 0,
		migrationCount: persisted.migrationCount ?? 0,
		rebootCount: persisted.rebootCount ?? 0,
		restartCount: persisted.restartCount ?? 0,
		resurrectCount: persisted.resurrectCount ?? 0,
		durationMillis,
		runTimeSecs: durationMillis / 1000,
		metamorph: 0,
		computeUnits,
	};
	for (const key of [
		'memAvgBytes',
		'memMaxBytes',
		'memCurrentBytes',
		'cpuAvgUsage',
		'cpuMaxUsage',
		'cpuCurrentUsage',
	] as const) {
		if (measured[key] !== undefined) stats[key] = measured[key];
	}

	const platformUsageUsd = roundUsd(computeUnits * STARTER_PLAN_COMPUTE_UNIT_PRICE_USD);
	const eventUsage = eventUsageFor(run);
	const eventsUsd = sumEventUsageUsd(eventUsage);

	return {
		stats,
		usage: { [ACTOR_COMPUTE_UNITS]: computeUnits },
		usageUsd: { [ACTOR_COMPUTE_UNITS]: platformUsageUsd },
		...(eventUsage ? { eventUsage } : {}),
		usageTotalUsd: roundUsd(platformUsageUsd + eventsUsd),
		platformUsageUsd,
		eventsUsd,
	};
}

/**
 * What counts against a pay-per-event run's `maxTotalChargeUsd` (the platform's cost enforcement, on
 * the charged basis): the events, plus the platform usage only when the pricing says the user pays it
 * (`isPPEPlatformUsagePaidByUser`). Otherwise the platform usage is the Actor owner's cost, not the
 * user's, and never counts toward the user's cap.
 */
export function chargeableTotalUsd(usage: RunUsage, run: Pick<RunRecord, 'pricingInfo'>): number {
	const platformShare = run.pricingInfo?.isPPEPlatformUsagePaidByUser ? usage.platformUsageUsd : 0;
	return roundUsd(usage.eventsUsd + platformShare);
}
