import assert from 'node:assert/strict';
import test from 'node:test';

import { assertFreshExecution } from '../scripts/recovery-guard.ts';

test('execution gate requires a clean, read-only-preflighted manifest', () => {
  assert.doesNotThrow(() => assertFreshExecution({ status: 'preflighted', actions: {} }));
  assert.throws(() => assertFreshExecution({ status: 'prepared', actions: {} }), /non-pristine/);
  assert.throws(() => assertFreshExecution({ status: 'running', actions: {} }), /non-pristine/);
  assert.throws(() => assertFreshExecution({ status: 'preflighted', actions: { deploy: {} } }), /non-pristine/);
  assert.throws(() => assertFreshExecution({ status: 'preflighted', actions: {}, contractAddress: 'deployed' }), /non-pristine/);
  assert.throws(() => assertFreshExecution({ status: 'preflighted', actions: {}, pending: { stage: 'deploy' } }), /non-pristine/);
});
