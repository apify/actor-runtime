/** Memory (MB) granted one full CPU core, per the platform's own memory-to-CPU ratio. */
const MEMORY_MBYTES_PER_CPU = 4096;

/** Docker's CFS period, in microseconds - the denominator `CpuQuota` is expressed against. */
export const CPU_PERIOD_US = 100_000;

/** Docker's protocol minimum for `HostConfig.CpuQuota` - a floor on the encoding, not a host clamp. */
const MIN_CPU_QUOTA_US = 1000;

/** The run's dedicated CPU cores, derived from its memory grant alone. */
export function dedicatedCpusFor(memoryMbytes: number): number {
	return memoryMbytes / MEMORY_MBYTES_PER_CPU;
}

/** `HostConfig.CpuQuota` for a run granted `memoryMbytes`, paired with `CPU_PERIOD_US`. */
export function cpuQuotaFor(memoryMbytes: number): number {
	const rawQuota = dedicatedCpusFor(memoryMbytes) * CPU_PERIOD_US;
	return Math.max(MIN_CPU_QUOTA_US, Math.round(rawQuota));
}

/** The platform's accepted memory grants: powers of two, from 128 MB to 32 GB. */
const MIN_PLATFORM_MEMORY_MBYTES = 128;
const MAX_PLATFORM_MEMORY_MBYTES = 32_768;

/**
 * A warning for a memory grant the Apify platform would refuse outright, or `undefined` for one it
 * accepts. This runtime applies whatever it is given (`unsupported.md` - memory steps and bounds are
 * deliberately not enforced), so the run still starts; what the warning buys is that a developer finds
 * out here rather than on the first platform run. Worth saying for pay-per-event Actors especially: the
 * pre-charged `apify-actor-start` count is one per *whole* gigabyte, so a grant between two steps pays
 * for the lower one.
 */
export function platformIncompatibleMemoryWarning(memoryMbytes: number): string | undefined {
	const defects: string[] = [];
	if (memoryMbytes < MIN_PLATFORM_MEMORY_MBYTES || memoryMbytes > MAX_PLATFORM_MEMORY_MBYTES) {
		defects.push(`outside the ${MIN_PLATFORM_MEMORY_MBYTES} MB - ${MAX_PLATFORM_MEMORY_MBYTES} MB range`);
	}
	if (!Number.isInteger(Math.log2(memoryMbytes))) defects.push('not a power of two');
	if (defects.length === 0) return undefined;

	return (
		`Warning: the requested memory of ${memoryMbytes} MB is ${defects.join(' and ')}, which the Apify ` +
		`platform refuses (it accepts powers of two from ${MIN_PLATFORM_MEMORY_MBYTES} MB to ` +
		`${MAX_PLATFORM_MEMORY_MBYTES} MB). Running with it anyway.`
	);
}
