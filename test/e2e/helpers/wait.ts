/**
 * Polls `check` until it returns a defined value or `timeoutMs` elapses. An async `check` is `await`ed,
 * so it is genuinely retried on each poll; one that throws is retried too, not propagated.
 * `debug-mode.test.ts` carries the Docker-free self-check pinning both properties.
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
