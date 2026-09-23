import { describe, expect, it } from 'vitest';

import { platformIncompatibleMemoryWarning } from '../../src/resources.js';

describe('platformIncompatibleMemoryWarning', () => {
	it('says nothing about a grant the platform accepts', () => {
		for (const memoryMbytes of [128, 256, 512, 1024, 2048, 4096, 8192, 32_768]) {
			expect(platformIncompatibleMemoryWarning(memoryMbytes)).toBeUndefined();
		}
	});

	it('names the defect of a grant the platform refuses, without refusing it here', () => {
		const betweenSteps = platformIncompatibleMemoryWarning(8096);
		expect(betweenSteps).toContain('8096 MB is not a power of two');
		expect(betweenSteps).toContain('Running with it anyway.');

		expect(platformIncompatibleMemoryWarning(64)).toContain('outside the 128 MB - 32768 MB range');
		expect(platformIncompatibleMemoryWarning(65_536)).toContain('outside the 128 MB - 32768 MB range');
	});

	it('names both defects of a grant that is out of range and off the steps', () => {
		expect(platformIncompatibleMemoryWarning(100)).toContain(
			'outside the 128 MB - 32768 MB range and not a power of two',
		);
	});
});
