import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initTokenVault } from '../src/services/token-vault.js';

// The runtime loads its key at startup (`index.ts`); tests start storage on their own, so each worker gets one.
initTokenVault(mkdtempSync(join(tmpdir(), 'actor-runtime-test-key-')));
