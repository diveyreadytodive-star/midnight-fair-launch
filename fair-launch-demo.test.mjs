import assert from 'node:assert/strict';
import test from 'node:test';
import { DemoInputError, simulateFourSlotAuction } from './fair-launch-demo.js';

const base = { inventory: 600, reserve: 8, deposit: 5000 };
const bid = (price, quantity) => ({ price, quantity });

test('simulator reproduces the recorded four-slot clearing and refund numbers', () => {
  assert.deepEqual(simulateFourSlotAuction({ ...base, bids: [bid(12, 300), bid(10, 300), bid(8, 300), bid(8, 300)] }), {
    status: 'settled', clearingPrice: '10', allocations: ['300', '300', '0', '0'],
    refunds: ['2000', '2000', '5000', '5000'], proceeds: '6000', unsold: '0',
  });
});

test('a higher fourth bid displaces the earlier lower bid without changing deposit rules', () => {
  assert.deepEqual(simulateFourSlotAuction({ ...base, bids: [bid(12, 300), bid(10, 300), bid(8, 300), bid(13, 300)] }), {
    status: 'settled', clearingPrice: '12', allocations: ['300', '0', '0', '300'],
    refunds: ['1400', '5000', '5000', '1400'], proceeds: '7200', unsold: '0',
  });
});

test('underdemand clears at reserve and leaves unsold inventory', () => {
  const result = simulateFourSlotAuction({ ...base, bids: [bid(12, 30), bid(10, 30), bid(8, 30), bid(9, 30)] });
  assert.equal(result.clearingPrice, '8');
  assert.deepEqual(result.allocations, ['30', '30', '30', '30']);
  assert.equal(result.unsold, '480');
});

test('non-integral marginal allocations are unsupported by the current contract', () => {
  const result = simulateFourSlotAuction({ ...base, bids: [bid(12, 299), bid(10, 200), bid(10, 200), bid(8, 100)] });
  assert.equal(result.status, 'non-integral');
});

test('invalid bids cannot exceed the fixed deposit or fall below reserve', () => {
  assert.throws(() => simulateFourSlotAuction({ ...base, bids: [bid(20, 300), bid(10, 300), bid(8, 300), bid(8, 300)] }), DemoInputError);
  assert.throws(() => simulateFourSlotAuction({ ...base, bids: [bid(7, 300), bid(10, 300), bid(8, 300), bid(8, 300)] }), DemoInputError);
});
