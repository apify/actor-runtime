/** Prints the run's own log when `assertions` fails, then rethrows. `expected +0 to be 4` alone cannot
 * say whether the pages were fetched and the items lost, or never fetched; the crawl's log can. */
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
