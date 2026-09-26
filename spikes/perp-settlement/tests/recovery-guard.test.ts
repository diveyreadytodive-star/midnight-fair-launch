import assert from 'node:assert/strict';
import test from 'node:test';

import { assertFreshExecution } from '../scripts/recovery-guard.ts';

test('execution gate accepts only a pristine prepared recovery manifest', () => {
  assert.doesNotThrow(() => assertFreshExecution({ status: 'prepared', actions: {} }));
});

test('execution gate rejects interrupted, pending, or previously deployed runs', () => {
  assert.throws(() => assertFreshExecution({ status: 'running', actions: {} }), /non-pristine/);
  assert.throws(() => assertFreshExecution({ status: 'prepared', actions: { deploy: {} } }), /non-pristine/);
  assert.throws(() => assertFreshExecution({ status: 'prepared', actions: {}, contractAddress: 'deployed' }), /non-pristine/);
  assert.throws(() => assertFreshExecution({ status: 'prepared', actions: {}, pending: { stage: 'deploy' } }), /non-pristine/);
});
