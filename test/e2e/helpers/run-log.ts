/**
 * Prints the run's own log when `assertions` fails, then rethrows unchanged.
 *
 * A crawl that ends with no items, or one that never finishes, is indistinguishable from the assertion
 * alone: `expected +0 to be 4` says nothing about whether the pages were fetched and the items lost, or
 * never fetched at all. The run's log separates those - Crawlee logs a line per page it processes, and
 * its navigation failures and retries too - so a CI failure carries the crawl's side of the story.
 */
export async function withRunLogOnFailure<T>(
	runId: string,
	getLog: () => string,
	assertions: () => Promise<T>,
): Promise<T> {
	try {
		return await assertions();
	} catch (error) {
		let log: string;
		try {
			log = getLog();
		} catch (logError) {
			log = `(could not be read: ${String(logError)})`;
		}
		process.stdout.write(`\n--- run ${runId} log ---\n${log}\n--- end run ${runId} log ---\n\n`);
		throw error;
	}
}
