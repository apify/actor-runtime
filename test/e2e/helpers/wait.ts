/**
 * Polls `check` until it returns a defined value or `timeoutMs` elapses. `check` may be sync or async -
 * either way its result is `await`ed before being tested, so an async check is genuinely retried on each
 * poll rather than resolving this function on its very first call with whatever that one probe happened
 * to return. A check that throws (a transient CLI/HTTP hiccup) is treated the same as one that returns
 * `undefined` - retried, not propagated - so a single flaky poll can't fail the whole wait before its
 * deadline.
 *
 * Shared by every e2e file that waits on a run's own progress; `debug-mode.test.ts` carries the
 * Docker-free self-check that pins both properties above.
 */
export async function waitFor<T>(
	check: () => T | undefined | Promise<T | undefined>,
	timeoutMs: number,
	description: string,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		let result: T | undefined;
		try {
			result = await check();
		} catch {
			result = undefined;
		}
		if (result !== undefined) return result;
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for: ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}
