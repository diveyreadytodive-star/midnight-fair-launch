import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { sampleCoinPublicKey } from '@midnight-ntwrk/midnight-js-protocol/ledger';

const contractPath = resolve('generated/risk_circuit/contract/index.js');
if (!existsSync(contractPath)) throw new Error('Run npm test to compile the Compact spike first.');
const Risk = await import(contractPath);

const BASE_INPUT = {
  sideIsLong: true,
  notional: 5000n,
  entryPrice: 100000n,
  markPrice: 90000n,
  borrowFee: 30n,
  fundingFee: 0n,
  fundingCredit: 0n,
  exitCost: 20n,
  protectiveBuffer: 225n,
  profitPayoutCap: 500n,
};
const ORACLE_TIME = 1000n;
const MAX_AGE = 50n;

function makeContract(divisionWitness = (_context: unknown, numerator: bigint, denominator: bigint) => ({
  quotient: numerator / denominator,
  remainder: numerator % denominator,
})) {
  return new Risk.Contract({
    quotientRemainder(context: { privateState: unknown }, numerator: bigint, denominator: bigint) {
      return [context.privateState, divisionWitness(context, numerator, denominator)];
    },
  });
}

function assess(
  input: typeof BASE_INPUT,
  now = ORACLE_TIME,
  observedAt = ORACLE_TIME,
  maxAge = MAX_AGE,
  contract = makeContract(),
) {
  const coinKey = sampleCoinPublicKey();
  const address = sampleContractAddress();
  const initial = contract.initialState(createConstructorContext({}, coinKey));
  const context = createCircuitContext(
    address,
    coinKey,
    initial.currentContractState,
    initial.currentPrivateState,
    undefined,
    undefined,
    Number(now),
  );
  return contract.circuits.assessBtcRisk(
    context,
    input,
    observedAt,
    maxAge,
    18n,
    17n,
  ).result;
}

test('BTC long at normalized P90 matches the calculator protective-close fixture', () => {
  const result = assess(BASE_INPUT);
  assert.equal(result.pnlIsLoss, true);
  assert.equal(result.pnlMagnitude, 500n);
  assert.equal(result.currentNotional, 4500n);
  assert.equal(result.maintenance, 225n);
  assert.equal(result.equityIsNegative, false);
  assert.equal(result.equityMagnitude, 470n);
  assert.equal(result.shouldProtectiveClose, true);
  assert.equal(result.isLiquidatable, false);
  assert.equal(result.traderPayout, 450n);
});

test('BTC long at normalized P84 is liquidatable and protection paths do not overlap', () => {
  const result = assess({ ...BASE_INPUT, markPrice: 84000n });
  assert.equal(result.pnlMagnitude, 800n);
  assert.equal(result.currentNotional, 4200n);
  assert.equal(result.maintenance, 210n);
  assert.equal(result.equityMagnitude, 170n);
  assert.equal(result.isLiquidatable, true);
  assert.equal(result.shouldProtectiveClose, false);
  assert.equal(result.traderPayout, 150n);
});

test('max profit payout is capped to fixed liability and short risk reverses direction', () => {
  const profitableLong = assess({ ...BASE_INPUT, markPrice: 200000n, borrowFee: 0n });
  assert.equal(profitableLong.pnlIsLoss, false);
  assert.equal(profitableLong.pnlMagnitude, 5000n);
  assert.equal(profitableLong.equityMagnitude, 6000n);
  assert.equal(profitableLong.traderPayout, 1500n);
  assert.equal(profitableLong.profitPaid, 500n);

  const losingShort = assess({ ...BASE_INPUT, sideIsLong: false, markPrice: 110000n });
  assert.equal(losingShort.pnlIsLoss, true);
  assert.equal(losingShort.pnlMagnitude, 500n);
  assert.equal(losingShort.equityMagnitude, 470n);
});

test('negative signed equity is represented by sign and magnitude, preserving shortfall', () => {
  const result = assess({
    ...BASE_INPUT,
    sideIsLong: false,
    markPrice: 130000n,
    exitCost: 20n,
  });
  assert.equal(result.equityIsNegative, true);
  assert.equal(result.equityMagnitude, 530n);
  assert.equal(result.isLiquidatable, true);
  assert.equal(result.traderPayout, 0n);
  assert.equal(result.insuranceShortfall, 550n);
});

test('loss PnL uses ceiling magnitude to match mathematical floor for negative PnL', () => {
  const result = assess({
    ...BASE_INPUT,
    notional: 10n,
    entryPrice: 3n,
    markPrice: 2n,
    borrowFee: 0n,
    exitCost: 0n,
    protectiveBuffer: 0n,
    profitPayoutCap: 0n,
  });
  assert.equal(result.pnlMagnitude, 4n);
  assert.equal(result.equityMagnitude, 996n);
});

test('only a mathematically valid quotient/remainder witness is accepted', () => {
  const malicious = makeContract((_context, numerator, denominator) => ({
    quotient: numerator / denominator + 1n,
    remainder: numerator % denominator,
  }));
  assert.throws(
    () => assess(BASE_INPUT, ORACLE_TIME, ORACLE_TIME, MAX_AGE, malicious),
    /INVALID_DIVISION_WITNESS/,
  );
});

test('oracle timestamp accepts the inclusive max-age boundary and rejects stale or future data', () => {
  assert.doesNotThrow(() => assess(BASE_INPUT, 1000n, 950n, 50n));
  assert.throws(() => assess(BASE_INPUT, 1000n, 949n, 50n), /ORACLE_STALE/);
  assert.throws(() => assess(BASE_INPUT, 1000n, 1001n, 50n), /ORACLE_TIMESTAMP_IN_FUTURE/);
});

test('oracle sequence must be newer than the previously accepted sequence', () => {
  const contract = makeContract();
  const coinKey = sampleCoinPublicKey();
  const address = sampleContractAddress();
  const initial = contract.initialState(createConstructorContext({}, coinKey));
  const context = createCircuitContext(
    address,
    coinKey,
    initial.currentContractState,
    initial.currentPrivateState,
    undefined,
    undefined,
    Number(ORACLE_TIME),
  );
  assert.doesNotThrow(() => contract.circuits.assessBtcRisk(
    context,
    BASE_INPUT,
    ORACLE_TIME,
    MAX_AGE,
    18n,
    17n,
  ));

  const staleContext = createCircuitContext(
    address,
    coinKey,
    initial.currentContractState,
    initial.currentPrivateState,
    undefined,
    undefined,
    Number(ORACLE_TIME),
  );
  assert.throws(() => contract.circuits.assessBtcRisk(
    staleContext,
    BASE_INPUT,
    ORACLE_TIME,
    MAX_AGE,
    17n,
    17n,
  ), /ORACLE_SEQUENCE_NOT_NEWER/);
});

test('zero prices, excessive notional, invalid payout reserve, and ambiguous funding reject', () => {
  assert.throws(() => assess({ ...BASE_INPUT, entryPrice: 0n }), /ENTRY_PRICE_ZERO/);
  assert.throws(() => assess({ ...BASE_INPUT, markPrice: 0n }), /MARK_PRICE_ZERO/);
  assert.throws(() => assess({ ...BASE_INPUT, notional: 5001n }), /NOTIONAL_EXCEEDS_FIXED_SLOT_LEVERAGE/);
  assert.throws(() => assess({ ...BASE_INPUT, profitPayoutCap: 501n }), /PAYOUT_CAP_EXCEEDS_FIXED_LIABILITY/);
  assert.throws(() => assess({ ...BASE_INPUT, fundingFee: 1n, fundingCredit: 1n }), /FUNDING_SIGN_AMBIGUOUS/);
});
