import { HOSTED } from '../config.js';
import { DockerDriver } from './docker-driver.js';
import { ProcessDriver } from './process/process-driver.js';
import type { Driver } from './types.js';

export type { BuildContext, BuildOutcome, Driver, RunContext, RunOutcome } from './types.js';

/** `ACTOR_RUNTIME_DRIVER=docker|process`; hosted mode defaults to `process`, which needs no engine. */
export async function createDriver(): Promise<Driver> {
	const choice = process.env.ACTOR_RUNTIME_DRIVER ?? (HOSTED ? 'process' : 'docker');
	if (choice !== 'docker' && choice !== 'process') {
		throw new Error(`ACTOR_RUNTIME_DRIVER must be 'docker' or 'process', got '${choice}'.`);
	}
	const driver = choice === 'process' ? new ProcessDriver() : new DockerDriver();
	await driver.init();
	return driver;
}
