/** The `{ "error": { "type", "message" } }` shape apify-client-js expects, keyed by `type`. */
export class ApiError extends Error {
	constructor(
		public readonly status: number,
		public readonly type: string,
		message: string,
	) {
		super(message);
	}
}

/**
 * apify-client-js keys its "return `undefined` instead of throwing" behaviour off this exact type -
 * `apify push`'s "does this Actor exist" probe depends on it.
 */
export function recordNotFound(message = 'Record was not found'): ApiError {
	return new ApiError(404, 'record-not-found', message);
}

export function invalidRequest(message: string): ApiError {
	return new ApiError(400, 'invalid-request', message);
}

/**
 * Matches the real Apify platform exactly: `DELETE /v2/actor-runs/:runId` on a non-terminal run is
 * rejected rather than aborted-then-deleted (the public API answers 400 `cannot-remove-running-run`),
 * so this runtime does the same instead of silently leaking the run's container.
 */
export function cannotRemoveRunningRun(): ApiError {
	return new ApiError(
		400,
		'cannot-remove-running-run',
		'It is not possible to delete a run that has not finished yet.',
	);
}

/** Matches the real platform's rejection of reboot/migrate on a finished run (the public API answers
 * 403 `job-finished`). */
export function jobAlreadyFinished(): ApiError {
	return new ApiError(403, 'job-finished', 'Actor job is already finished.');
}

/**
 * Matches the real Apify platform exactly: `DELETE /v2/actor-builds/:buildId` on a non-terminal build
 * is rejected rather than aborted-then-deleted (the public API answers 400 `deleting-unfinished-build`).
 */
export function deletingUnfinishedBuild(): ApiError {
	return new ApiError(400, 'deleting-unfinished-build', 'Deleting unfinished build while running is not allowed');
}

/** Matches the platform's `cannot-charge-non-pay-per-event-actor` (HTTP 405): `POST .../charge` against a
 * run whose pricing is not pay-per-event. */
export function cannotChargeNonPayPerEventActor(): ApiError {
	return new ApiError(
		405,
		'cannot-charge-non-pay-per-event-actor',
		'You cannot charge events for an Actor that is not paid per event.',
	);
}

/** Matches the platform's `cannot-charge-apify-event` (HTTP 405): the `apify-` prefixed synthetic events
 * are charged by the platform itself, never through the charge endpoint. */
export function cannotChargeApifyEvent(eventName: string): ApiError {
	return new ApiError(
		405,
		'cannot-charge-apify-event',
		`Event "${eventName}" is system event and cannot be charged.`,
	);
}
