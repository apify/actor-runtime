/**
 * Actor pricing (`actor-driver.md`'s "Pay-per-event pricing" section): the platform's own
 * `Actor.pricingInfos` field, validated here for `POST`/`PUT /v2/actors` and the console's pricing form,
 * and resolved per run at run start. Pure - no registry access - so it is unit-testable on its own.
 *
 * Only the `FREE` and `PAY_PER_EVENT` models are accepted: those are the two whose observable behaviour
 * the runtime emulates (`unsupported.md` keeps rental and pay-per-result out of scope). A tiered event
 * price is resolved to the BRONZE tier - the lowest paid subscription tier (the Starter plan), the same
 * tier every cost figure this runtime reports is priced at (`services/run-usage.ts`).
 */
import type {
	ActorChargeEventRecord,
	ActorPricingInfoRecord,
	ActorPricingModel,
	RunPricingInfoRecord,
} from '../storage/entities.js';

/** The synthetic events the platform itself charges (never an Actor's own `charge` call); the SDKs
 * track these client-side and skip the charge endpoint for anything with the `apify-` prefix. */
export const APIFY_EVENTS_PREFIX = 'apify-';
export const ACTOR_START_EVENT_NAME = 'apify-actor-start';
export const DEFAULT_DATASET_ITEM_EVENT_NAME = 'apify-default-dataset-item';

/** The tier tiered event prices resolve to: the lowest paid subscription tier (Starter). */
export const RESOLVED_PRICING_TIER = 'BRONZE';

const SUPPORTED_PRICING_MODELS: readonly ActorPricingModel[] = ['FREE', 'PAY_PER_EVENT'];
const KNOWN_PRICING_MODELS: readonly ActorPricingModel[] = [
	'FREE',
	'FLAT_PRICE_PER_MONTH',
	'PRICE_PER_DATASET_ITEM',
	'PAY_PER_EVENT',
];

const PRICING_INFO_FIELDS = [
	'pricingModel',
	'createdAt',
	'startedAt',
	'apifyMarginPercentage',
	'reasonForChange',
	'pricingPerEvent',
	'minimalMaxTotalChargeUsd',
	'isPPEPlatformUsagePaidByUser',
] as const;

const CHARGE_EVENT_FIELDS = [
	'eventTitle',
	'eventDescription',
	'eventPriceUsd',
	'eventTieredPricingUsd',
	'isOneTimeEvent',
	'isPrimaryEvent',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Either outcome of `validatePricingInfos`; `message` is reused verbatim by the API's `400` and the
 * console's inline error. */
export type ValidatedPricingInfos =
	{ kind: 'ok'; pricingInfos: ActorPricingInfoRecord[] } | { kind: 'invalid'; message: string };

/** The shared rejection shape of every validator below; assignable to each one's own result union. */
function invalid(message: string): { kind: 'invalid'; message: string } {
	return { kind: 'invalid', message };
}

/** An ISO-8601 timestamp, or `undefined` for a missing/invalid one. */
function parseTimestamp(value: unknown): string | undefined {
	if (typeof value !== 'string' && !(value instanceof Date)) return undefined;
	const millis = value instanceof Date ? value.getTime() : Date.parse(value);
	return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

function validateChargeEvent(
	eventName: string,
	raw: unknown,
	where: string,
): { kind: 'ok'; event: ActorChargeEventRecord } | { kind: 'invalid'; message: string } {
	if (!isPlainObject(raw)) return invalid(`${where}: event "${eventName}" must be a JSON object`);
	const unknownKey = Object.keys(raw).find((key) => !(CHARGE_EVENT_FIELDS as readonly string[]).includes(key));
	if (unknownKey) {
		return invalid(
			`${where}: event "${eventName}" has an unknown field "${unknownKey}" - allowed fields are ` +
				CHARGE_EVENT_FIELDS.map((field) => `"${field}"`).join(', ') +
				'.',
		);
	}
	if (typeof raw.eventTitle !== 'string' || raw.eventTitle.trim() === '') {
		return invalid(`${where}: event "${eventName}" needs a non-empty "eventTitle"`);
	}
	if (raw.eventDescription !== undefined && typeof raw.eventDescription !== 'string') {
		return invalid(`${where}: event "${eventName}": "eventDescription" must be a string`);
	}
	const flags: { isOneTimeEvent?: boolean; isPrimaryEvent?: boolean } = {};
	for (const flag of ['isOneTimeEvent', 'isPrimaryEvent'] as const) {
		const value = raw[flag];
		if (value === undefined) continue;
		if (typeof value !== 'boolean') return invalid(`${where}: event "${eventName}": "${flag}" must be a boolean`);
		flags[flag] = value;
	}

	const hasFlat = raw.eventPriceUsd !== undefined;
	const hasTiered = raw.eventTieredPricingUsd !== undefined;
	if (hasFlat === hasTiered) {
		return invalid(
			`${where}: event "${eventName}" needs exactly one of "eventPriceUsd" or "eventTieredPricingUsd"`,
		);
	}

	const event: ActorChargeEventRecord = {
		eventTitle: raw.eventTitle,
		eventDescription: typeof raw.eventDescription === 'string' ? raw.eventDescription : '',
		...flags,
	};

	if (hasFlat) {
		if (!isNonNegativeNumber(raw.eventPriceUsd)) {
			return invalid(`${where}: event "${eventName}": "eventPriceUsd" must be a number >= 0`);
		}
		event.eventPriceUsd = raw.eventPriceUsd;
		return { kind: 'ok', event };
	}

	if (!isPlainObject(raw.eventTieredPricingUsd)) {
		return invalid(`${where}: event "${eventName}": "eventTieredPricingUsd" must be an object keyed by tier`);
	}
	const tiers: Record<string, { tieredEventPriceUsd: number }> = {};
	for (const [tier, tierRaw] of Object.entries(raw.eventTieredPricingUsd)) {
		if (!isPlainObject(tierRaw) || !isNonNegativeNumber(tierRaw.tieredEventPriceUsd)) {
			return invalid(`${where}: event "${eventName}": tier "${tier}" needs a "tieredEventPriceUsd" number >= 0`);
		}
		tiers[tier] = { tieredEventPriceUsd: tierRaw.tieredEventPriceUsd };
	}
	if (!tiers[RESOLVED_PRICING_TIER]) {
		return invalid(
			`${where}: event "${eventName}": "eventTieredPricingUsd" must include the "${RESOLVED_PRICING_TIER}" tier - ` +
				'the tier this runtime prices runs at',
		);
	}
	event.eventTieredPricingUsd = tiers;
	return { kind: 'ok', event };
}

function validatePricingInfo(raw: unknown, index: number, now: Date): ValidatedPricingInfos {
	const where = `pricingInfos[${index}]`;
	if (!isPlainObject(raw)) return invalid(`${where} must be a JSON object`);

	const unknownKey = Object.keys(raw).find((key) => !(PRICING_INFO_FIELDS as readonly string[]).includes(key));
	if (unknownKey) {
		return invalid(
			`${where} has an unknown field "${unknownKey}" - allowed fields are ` +
				PRICING_INFO_FIELDS.map((field) => `"${field}"`).join(', ') +
				'.',
		);
	}

	const model = raw.pricingModel;
	if (typeof model !== 'string' || !(KNOWN_PRICING_MODELS as readonly string[]).includes(model)) {
		return invalid(
			`${where}: "pricingModel" must be one of ${KNOWN_PRICING_MODELS.map((m) => `"${m}"`).join(', ')}`,
		);
	}
	if (!(SUPPORTED_PRICING_MODELS as readonly string[]).includes(model)) {
		return invalid(
			`${where}: pricing model "${model}" is not emulated by this runtime - only "FREE" and "PAY_PER_EVENT" are`,
		);
	}
	const pricingModel = model as ActorPricingModel;

	for (const field of ['createdAt', 'startedAt'] as const) {
		if (raw[field] !== undefined && parseTimestamp(raw[field]) === undefined) {
			return invalid(`${where}: "${field}" must be an ISO-8601 timestamp`);
		}
	}
	if (raw.apifyMarginPercentage !== undefined) {
		const margin = raw.apifyMarginPercentage;
		if (typeof margin !== 'number' || !Number.isFinite(margin) || margin < 0 || margin > 1) {
			return invalid(`${where}: "apifyMarginPercentage" must be a number between 0 and 1`);
		}
	}
	if (raw.reasonForChange !== undefined && typeof raw.reasonForChange !== 'string') {
		return invalid(`${where}: "reasonForChange" must be a string`);
	}

	const startedAt = parseTimestamp(raw.startedAt) ?? now.toISOString();
	const info: ActorPricingInfoRecord = {
		pricingModel,
		createdAt: parseTimestamp(raw.createdAt) ?? startedAt,
		startedAt,
		apifyMarginPercentage: typeof raw.apifyMarginPercentage === 'number' ? raw.apifyMarginPercentage : 0,
		...(typeof raw.reasonForChange === 'string' ? { reasonForChange: raw.reasonForChange } : {}),
	};

	const ppeOnly = ['pricingPerEvent', 'minimalMaxTotalChargeUsd', 'isPPEPlatformUsagePaidByUser'] as const;
	if (pricingModel === 'FREE') {
		const misplaced = ppeOnly.find((field) => raw[field] !== undefined);
		if (misplaced) return invalid(`${where}: "${misplaced}" is only valid with "pricingModel": "PAY_PER_EVENT"`);
		return { kind: 'ok', pricingInfos: [info] };
	}

	if (!isPlainObject(raw.pricingPerEvent) || !isPlainObject(raw.pricingPerEvent.actorChargeEvents)) {
		return invalid(`${where}: a PAY_PER_EVENT pricing needs "pricingPerEvent": { "actorChargeEvents": { ... } }`);
	}
	const extraKey = Object.keys(raw.pricingPerEvent).find((key) => key !== 'actorChargeEvents');
	if (extraKey) return invalid(`${where}: "pricingPerEvent" has an unknown field "${extraKey}"`);

	const events: Record<string, ActorChargeEventRecord> = {};
	for (const [eventName, eventRaw] of Object.entries(raw.pricingPerEvent.actorChargeEvents)) {
		if (eventName.trim() === '') return invalid(`${where}: an event name must not be empty`);
		const result = validateChargeEvent(eventName, eventRaw, where);
		if (result.kind === 'invalid') return result;
		events[eventName] = result.event;
	}
	if (Object.keys(events).length === 0) {
		return invalid(`${where}: "actorChargeEvents" must define at least one event`);
	}
	info.pricingPerEvent = { actorChargeEvents: events };

	if (raw.minimalMaxTotalChargeUsd !== undefined) {
		if (!isNonNegativeNumber(raw.minimalMaxTotalChargeUsd)) {
			return invalid(`${where}: "minimalMaxTotalChargeUsd" must be a number >= 0`);
		}
		info.minimalMaxTotalChargeUsd = raw.minimalMaxTotalChargeUsd;
	}
	if (raw.isPPEPlatformUsagePaidByUser !== undefined) {
		if (typeof raw.isPPEPlatformUsagePaidByUser !== 'boolean') {
			return invalid(`${where}: "isPPEPlatformUsagePaidByUser" must be a boolean`);
		}
		info.isPPEPlatformUsagePaidByUser = raw.isPPEPlatformUsagePaidByUser;
	}
	return { kind: 'ok', pricingInfos: [info] };
}

/**
 * Validates and normalizes a caller-supplied `pricingInfos` array (the body field of `POST`/`PUT
 * /v2/actors`, or the console form's JSON). Every entry comes out with `createdAt`, `startedAt` (both
 * default to `now`) and `apifyMarginPercentage` (default `0`) filled in, so the stored shape satisfies
 * every field the public API and the SDKs' pydantic models mark required. An empty array is valid and
 * means "no pricing".
 */
export function validatePricingInfos(raw: unknown, now = new Date()): ValidatedPricingInfos {
	if (!Array.isArray(raw)) return invalid('"pricingInfos" must be a JSON array');
	const pricingInfos: ActorPricingInfoRecord[] = [];
	for (const [index, entry] of raw.entries()) {
		const result = validatePricingInfo(entry, index, now);
		if (result.kind === 'invalid') return result;
		pricingInfos.push(...result.pricingInfos);
	}
	return { kind: 'ok', pricingInfos };
}

/** The pricing in effect at `date`: the entry with the latest `startedAt` not after `date` (the
 * platform's `getActorPricingInfoEffectiveAtDate`). `undefined` when none has started yet. */
export function effectivePricingInfo(
	pricingInfos: readonly ActorPricingInfoRecord[] | undefined,
	date = new Date(),
): ActorPricingInfoRecord | undefined {
	let effective: ActorPricingInfoRecord | undefined;
	for (const info of pricingInfos ?? []) {
		const startedAt = Date.parse(info.startedAt);
		if (startedAt > date.getTime()) continue;
		if (!effective || startedAt > Date.parse(effective.startedAt)) effective = info;
	}
	return effective;
}

/**
 * The pricing a run is created under: the Actor's effective pricing with every tiered event price
 * collapsed to the `RESOLVED_PRICING_TIER` price. `undefined` for an Actor without pricing, which the
 * run object then simply omits - the SDKs treat that as "not pay-per-event".
 */
export function resolveRunPricingInfo(
	pricingInfos: readonly ActorPricingInfoRecord[] | undefined,
	date = new Date(),
): RunPricingInfoRecord | undefined {
	const effective = effectivePricingInfo(pricingInfos, date);
	if (!effective) return undefined;
	const resolved: RunPricingInfoRecord = {
		pricingModel: effective.pricingModel,
		createdAt: effective.createdAt,
		startedAt: effective.startedAt,
		apifyMarginPercentage: effective.apifyMarginPercentage,
	};
	if (effective.pricingModel !== 'PAY_PER_EVENT' || !effective.pricingPerEvent) return resolved;

	const actorChargeEvents: NonNullable<RunPricingInfoRecord['pricingPerEvent']>['actorChargeEvents'] = {};
	for (const [eventName, event] of Object.entries(effective.pricingPerEvent.actorChargeEvents)) {
		const eventPriceUsd =
			event.eventPriceUsd ?? event.eventTieredPricingUsd?.[RESOLVED_PRICING_TIER]?.tieredEventPriceUsd ?? 0;
		actorChargeEvents[eventName] = {
			eventTitle: event.eventTitle,
			eventDescription: event.eventDescription,
			eventPriceUsd,
			...(event.isOneTimeEvent !== undefined ? { isOneTimeEvent: event.isOneTimeEvent } : {}),
			...(event.isPrimaryEvent !== undefined ? { isPrimaryEvent: event.isPrimaryEvent } : {}),
		};
	}
	resolved.pricingPerEvent = { actorChargeEvents };
	if (effective.minimalMaxTotalChargeUsd !== undefined) {
		resolved.minimalMaxTotalChargeUsd = effective.minimalMaxTotalChargeUsd;
	}
	if (effective.isPPEPlatformUsagePaidByUser !== undefined) {
		resolved.isPPEPlatformUsagePaidByUser = effective.isPPEPlatformUsagePaidByUser;
	}
	return resolved;
}

export function isPayPerEvent(pricingInfo: RunPricingInfoRecord | undefined): pricingInfo is RunPricingInfoRecord & {
	pricingPerEvent: NonNullable<RunPricingInfoRecord['pricingPerEvent']>;
} {
	return pricingInfo?.pricingModel === 'PAY_PER_EVENT' && pricingInfo.pricingPerEvent !== undefined;
}

/**
 * The `chargedEventCounts` a fresh run starts with (the platform's `getInitialChargedEventCounts`):
 * every priced event at `0`, and - when the pricing defines the synthetic `apify-actor-start` event -
 * that one pre-charged once per whole gigabyte of the run's memory, at least once.
 */
export function initialChargedEventCounts(
	pricingInfo: RunPricingInfoRecord | undefined,
	memoryMbytes: number,
): Record<string, number> | undefined {
	if (!isPayPerEvent(pricingInfo)) return undefined;
	const counts: Record<string, number> = {};
	for (const eventName of Object.keys(pricingInfo.pricingPerEvent.actorChargeEvents)) counts[eventName] = 0;
	if (ACTOR_START_EVENT_NAME in counts) {
		counts[ACTOR_START_EVENT_NAME] = Math.max(1, Math.floor(memoryMbytes / 1024));
	}
	return counts;
}
