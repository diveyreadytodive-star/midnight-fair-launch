import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createCircuitContext, createConstructorContext, sampleContractAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { sampleCoinPublicKey } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import {
  PRICE_TICKS_PER_USD,
  calculatePositionRisk,
  type RiskPolicy as ReferenceRiskPolicy,
} from '../../../src/risk/calculator.ts';

const spikeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = resolve(spikeDir, 'generated/oracle_risk/contract/index.js');
if (!existsSync(contractPath)) throw new Error('Run npm test to compile the Compact spike first.');
const OracleRisk = await import(contractPath);

const NETWORK_DOMAIN = new Uint8Array(32).fill(11);
const ORACLE_SECRET = new Uint8Array(32).fill(21);
const OPERATOR_SECRET = new Uint8Array(32).fill(31);
const OWNER_SECRET = new Uint8Array(32).fill(41);
const POSITION_SALT = new Uint8Array(32).fill(51);
const NOW = 1_000n;
const BTC_PRICE_SCALE = PRICE_TICKS_PER_USD;
const POLICY = {
  collateralAtoms: 1_000_000_000n,
  maxNotionalAtoms: 5_000_000_000n,
  feeAtoms: 0n,
  maintenanceBps: 500n,
  exitCostAtoms: 20_000_000n,
  profitCapAtoms: 500_000_000n,
  oracleMaxAgeSeconds: 60n,
};
const TERMS = {
  isLong: true,
  notionalAtoms: POLICY.maxNotionalAtoms,
  entryPriceTicks: 100_000n * BTC_PRICE_SCALE,
  guardBufferAtoms: 255_000_000n,
};

function makeContract(division = (_context: unknown, numerator: bigint, denominator: bigint) => ({
  quotient: numerator / denominator,
  remainder: numerator % denominator,
})) {
  return new OracleRisk.Contract({
    quotientRemainder(context: { privateState: unknown }, numerator: bigint, denominator: bigint) {
      return [context.privateState, division(context, numerator, denominator)];
    },
  });
}

function stateOf(result: { context: { currentQueryContext: { state: unknown } } }) {
  return result.context.currentQueryContext.state;
}

function publicLedger(state: unknown) {
  return OracleRisk.ledger((state as { data?: unknown }).data ?? state);
}

function fixture(options: {
  contract?: ReturnType<typeof makeContract>;
  initialPrice?: bigint;
  terms?: typeof TERMS;
  oracleSecret?: Uint8Array;
  operatorSecret?: Uint8Array;
  ownerSecret?: Uint8Array;
} = {}) {
  const contract = options.contract ?? makeContract();
  const key = sampleCoinPublicKey();
  const address = sampleContractAddress();
  const oracleSecret = options.oracleSecret ?? ORACLE_SECRET;
  const operatorSecret = options.operatorSecret ?? OPERATOR_SECRET;
  const ownerSecret = options.ownerSecret ?? OWNER_SECRET;
  const oracleCommitment = OracleRisk.pureCircuits.deriveOraclePublisherCommitment(NETWORK_DOMAIN, oracleSecret);
  const operatorCommitment = OracleRisk.pureCircuits.deriveOperatorRiskCommitment(NETWORK_DOMAIN, operatorSecret);
  const initial = contract.initialState(
    createConstructorContext({}, key),
    NETWORK_DOMAIN,
    oracleCommitment,
    operatorCommitment,
  );
  const published = contract.circuits.publishOracleQuote(
    makeContextFor(contract, key, address, initial.currentContractState),
    options.initialPrice ?? 100_000n * BTC_PRICE_SCALE,
    1n,
    NOW,
    oracleSecret,
  );
  const terms = options.terms ?? TERMS;
  const opened = contract.circuits.openPosition(
    makeContextFor(contract, key, address, stateOf(published)),
    terms,
    POSITION_SALT,
    ownerSecret,
  );
  return {
    contract,
    key,
    address,
    oracleSecret,
    operatorSecret,
    ownerSecret,
    terms,
    state: stateOf(opened),
  };
}

function makeContextFor(contract: ReturnType<typeof makeContract>, key: ReturnType<typeof sampleCoinPublicKey>, address: ReturnType<typeof sampleContractAddress>, state: unknown, now = NOW) {
  return createCircuitContext(address, key, state as never, {}, undefined, undefined, Number(now));
}

function publish(f: ReturnType<typeof fixture>, state: unknown, price: bigint, sequence: bigint, now = NOW, publishedAt = now, secret = f.oracleSecret) {
  return f.contract.circuits.publishOracleQuote(
    makeContextFor(f.contract, f.key, f.address, state, now),
    price,
    sequence,
    publishedAt,
    secret,
  );
}

function referenceRisk(markPrice: bigint) {
  const policy: ReferenceRiskPolicy = {
    minimumCollateral: 1n,
    maximumLeverageBps: 100_000n,
    maintenanceMarginBps: POLICY.maintenanceBps,
    estimatedExitCost: POLICY.exitCostAtoms,
    protectiveBuffer: TERMS.guardBufferAtoms,
    profitPayoutCap: POLICY.profitCapAtoms,
    riskSlotLiability: POLICY.profitCapAtoms,
    availableRiskReserve: POLICY.profitCapAtoms,
  };
  return calculatePositionRisk({
    side: 'long',
    collateral: POLICY.collateralAtoms,
    notional: POLICY.maxNotionalAtoms,
    entryPrice: TERMS.entryPriceTicks,
    markPrice,
    accruedBorrowFee: 0n,
    accruedFundingFee: 0n,
  }, policy);
}

function riskClose(f: ReturnType<typeof fixture>, state: unknown, options: {
  terms?: typeof TERMS;
  ownerIdentity?: Uint8Array;
  operatorSecret?: Uint8Array;
  now?: bigint;
} = {}) {
  const ownerIdentity = options.ownerIdentity ?? OracleRisk.pureCircuits.deriveOwnerIdentityCommitment(
    NETWORK_DOMAIN,
    f.ownerSecret,
  );
  return f.contract.circuits.riskClose(
    makeContextFor(f.contract, f.key, f.address, state, options.now ?? NOW),
    options.terms ?? f.terms,
    POSITION_SALT,
    ownerIdentity,
    options.operatorSecret ?? f.operatorSecret,
  );
}

test('fixed risk policy cannot be caller supplied or changed', () => {
  assert.deepEqual(OracleRisk.pureCircuits.fixedRiskPolicy(), POLICY);
});

test('opening rejects a guard that would already trigger at the entry price', () => {
  assert.throws(
    () => fixture({ terms: { ...TERMS, guardBufferAtoms: 730_000_000n } }),
    /GUARD_TRIGGERS_AT_ENTRY/,
  );
});

test('risk-close circuit rejects extra caller policy arguments', () => {
  const f = fixture();
  const marked = publish(f, f.state, 90_000n * BTC_PRICE_SCALE, 2n);
  assert.throws(
    () => f.contract.circuits.riskClose(
      makeContextFor(f.contract, f.key, f.address, stateOf(marked)),
      f.terms,
      POSITION_SALT,
      OracleRisk.pureCircuits.deriveOwnerIdentityCommitment(NETWORK_DOMAIN, f.ownerSecret),
      f.operatorSecret,
      999_999_999n,
    ),
    /expected 5 arguments/,
  );
});

test('P90 enters the private protective-close path and exposes only closed lifecycle state', () => {
  const f = fixture();
  const tsRisk = referenceRisk(90_000n * BTC_PRICE_SCALE);
  assert.equal(tsRisk.pnl, -500_000_000n);
  assert.equal(tsRisk.currentNotional, 4_500_000_000n);
  assert.equal(tsRisk.equity, 500_000_000n);
  assert.equal(tsRisk.maintenance, 225_000_000n);
  assert.equal(tsRisk.buffer, 255_000_000n);
  assert.equal(tsRisk.shouldProtectiveClose, true);
  assert.equal(tsRisk.isLiquidatable, false);
  const marked = publish(f, f.state, 90_000n * BTC_PRICE_SCALE, 2n);
  const closed = riskClose(f, stateOf(marked));
  const ledger = publicLedger(stateOf(closed));
  assert.deepEqual(closed.result, []);
  assert.equal(ledger.positionActive, false);
  assert.equal(ledger.positionClosed, true);
  assert.equal('riskMode' in ledger, false);
  assert.equal('liquidatable' in ledger, false);
  assert.equal('protective' in ledger, false);
});

test('P84 enters liquidation predicate through the same output-free circuit', () => {
  const f = fixture();
  const tsRisk = referenceRisk(84_000n * BTC_PRICE_SCALE);
  assert.equal(tsRisk.pnl, -800_000_000n);
  assert.equal(tsRisk.currentNotional, 4_200_000_000n);
  assert.equal(tsRisk.equity, 200_000_000n);
  assert.equal(tsRisk.maintenance, 210_000_000n);
  assert.equal(tsRisk.shouldProtectiveClose, false);
  assert.equal(tsRisk.isLiquidatable, true);
  const marked = publish(f, f.state, 84_000n * BTC_PRICE_SCALE, 2n);
  const closed = riskClose(f, stateOf(marked));
  assert.deepEqual(closed.result, []);
  assert.equal(publicLedger(stateOf(closed)).positionActive, false);
  assert.equal('riskMode' in publicLedger(stateOf(closed)), false);
});

test('a one-atom tighter private guard rejects P90 as healthy; failed proof leaves ledger unchanged', () => {
  const f = fixture({ terms: { ...TERMS, guardBufferAtoms: TERMS.guardBufferAtoms - 1n } });
  const marked = publish(f, f.state, 90_000n * BTC_PRICE_SCALE, 2n);
  const before = stateOf(marked);
  assert.throws(() => riskClose(f, before), /POSITION_HEALTHY/);
  assert.equal(publicLedger(before).positionActive, true);
});

test('loss PnL and maintenance round upward at the one-third quotient boundary', () => {
  const guardAtCeilBoundary = 613_333_332n;
  const terms = {
    isLong: true,
    notionalAtoms: 1_000_000_000n,
    entryPriceTicks: 3n,
    guardBufferAtoms: guardAtCeilBoundary,
  };
  const f = fixture({ initialPrice: 3n, terms });
  const marked = publish(f, f.state, 2n, 2n);
  assert.doesNotThrow(() => riskClose(f, stateOf(marked)));

  const tighter = fixture({
    initialPrice: 3n,
    terms: { ...terms, guardBufferAtoms: guardAtCeilBoundary - 1n },
  });
  const tighterMark = publish(tighter, tighter.state, 2n, 2n);
  assert.throws(() => riskClose(tighter, stateOf(tighterMark)), /POSITION_HEALTHY/);
});

test('protective close rejects equity below fixed exit cost even when guard is zero', () => {
  const terms = {
    isLong: true,
    notionalAtoms: 1_000_000_000n,
    entryPriceTicks: 1_000n * BTC_PRICE_SCALE,
    guardBufferAtoms: 0n,
  };
  const f = fixture({ initialPrice: 1_000n * BTC_PRICE_SCALE, terms });
  const marked = publish(f, f.state, 10n * BTC_PRICE_SCALE, 2n);
  // Equity = 10,000,000; maintenance = 500,000; fixed exit cost = 20,000,000.
  // This is not liquidatable yet, but the protocol cannot afford its protective exit.
  const tsRisk = calculatePositionRisk({
    side: 'long',
    collateral: POLICY.collateralAtoms,
    notional: terms.notionalAtoms,
    entryPrice: terms.entryPriceTicks,
    markPrice: 10n * BTC_PRICE_SCALE,
    accruedBorrowFee: 0n,
    accruedFundingFee: 0n,
  }, {
    minimumCollateral: 1n,
    maximumLeverageBps: 100_000n,
    maintenanceMarginBps: POLICY.maintenanceBps,
    estimatedExitCost: POLICY.exitCostAtoms,
    protectiveBuffer: 0n,
    profitPayoutCap: POLICY.profitCapAtoms,
    riskSlotLiability: POLICY.profitCapAtoms,
    availableRiskReserve: POLICY.profitCapAtoms,
  });
  assert.equal(tsRisk.equity, 10_000_000n);
  assert.equal(tsRisk.isLiquidatable, false);
  assert.equal(tsRisk.shouldProtectiveClose, false);
  assert.throws(() => riskClose(f, stateOf(marked)), /POSITION_HEALTHY/);
  assert.equal(publicLedger(stateOf(marked)).positionActive, true);
});

test('healthy positions cannot be risk-closed', () => {
  const f = fixture();
  const marked = publish(f, f.state, 99_000n * BTC_PRICE_SCALE, 2n);
  assert.throws(() => riskClose(f, stateOf(marked)), /POSITION_HEALTHY/);
});

test('oracle publisher preimage is required and a forged quote cannot change state', () => {
  const f = fixture();
  const before = f.state;
  assert.throws(
    () => publish(f, before, 90_000n * BTC_PRICE_SCALE, 2n, NOW, NOW, new Uint8Array(32).fill(99)),
    /UNAUTHORIZED_ORACLE_PUBLISHER/,
  );
  const wrongDomainCommitment = OracleRisk.pureCircuits.deriveOraclePublisherCommitment(
    new Uint8Array(32).fill(12),
    ORACLE_SECRET,
  );
  assert.notDeepEqual(wrongDomainCommitment, publicLedger(before).oraclePublisherCommitment);
  assert.equal(publicLedger(before).oraclePriceTicks, 100_000n * BTC_PRICE_SCALE);
  assert.equal(publicLedger(before).oracleSequence, 1n);
});

test('oracle sequence replay, zero quotes, stale quotes and future quotes reject', () => {
  const f = fixture();
  assert.throws(() => publish(f, f.state, 90_000n * BTC_PRICE_SCALE, 1n), /ORACLE_SEQUENCE_NOT_NEWER/);
  assert.throws(() => publish(f, f.state, 0n, 2n), /ORACLE_PRICE_ZERO/);
  assert.throws(() => publish(f, f.state, 90_000n * BTC_PRICE_SCALE, 2n, NOW, NOW - 1n), /ORACLE_TIMESTAMP_NOT_MONOTONIC/);
  assert.throws(() => publish(f, f.state, 90_000n * BTC_PRICE_SCALE, 2n, NOW + 61n, NOW), /ORACLE_STALE/);
  assert.throws(() => publish(f, f.state, 90_000n * BTC_PRICE_SCALE, 2n, NOW, NOW + 1n), /ORACLE_TIMESTAMP_IN_FUTURE/);
});

test('oracle freshness includes exactly 60 seconds but rejects 61 seconds', () => {
  const f = fixture();
  assert.doesNotThrow(() => publish(f, f.state, 90_000n * BTC_PRICE_SCALE, 2n, NOW + 60n, NOW));
  assert.throws(() => publish(f, f.state, 90_000n * BTC_PRICE_SCALE, 2n, NOW + 61n, NOW), /ORACLE_STALE/);
});

test('changed terms, guard, wrong operator secret, and owner secret cannot authorize operator close', () => {
  const f = fixture();
  const marked = publish(f, f.state, 90_000n * BTC_PRICE_SCALE, 2n);
  const markedState = stateOf(marked);
  assert.throws(
    () => riskClose(f, markedState, { terms: { ...TERMS, guardBufferAtoms: 254_999_999n } }),
    /POSITION_TERMS_MISMATCH/,
  );
  assert.throws(
    () => riskClose(f, markedState, { operatorSecret: f.ownerSecret }),
    /UNAUTHORIZED_RISK_OPERATOR/,
  );
  assert.throws(
    () => f.contract.circuits.ownerClose(
      makeContextFor(f.contract, f.key, f.address, markedState),
      TERMS,
      POSITION_SALT,
      f.operatorSecret,
    ),
    /POSITION_TERMS_MISMATCH/,
  );
  assert.equal(publicLedger(markedState).positionActive, true);
});

test('high adverse move stays within wide intermediates and conservatively closes', () => {
  const terms = {
    isLong: false,
    notionalAtoms: POLICY.maxNotionalAtoms,
    entryPriceTicks: 1n,
    guardBufferAtoms: 0n,
  };
  const f = fixture({ initialPrice: 1n, terms });
  const marked = publish(f, f.state, 1_000_000_000n, 2n);
  const closed = riskClose(f, stateOf(marked));
  assert.equal(publicLedger(stateOf(closed)).positionClosed, true);
});

test('current notional above Uint64 is rejected like the TypeScript reference', () => {
  const terms = {
    isLong: false,
    notionalAtoms: POLICY.maxNotionalAtoms,
    entryPriceTicks: 1n,
    guardBufferAtoms: 0n,
  };
  const f = fixture({ initialPrice: 1n, terms });
  const marked = publish(f, f.state, 9_000_000_000_000_000_000n, 2n);
  assert.throws(() => riskClose(f, stateOf(marked)), /CURRENT_NOTIONAL_OUT_OF_RANGE/);
  assert.equal(publicLedger(stateOf(marked)).positionActive, true);
});

test('forged quotient/remainder witnesses fail the arithmetic constraint', () => {
  let calls = 0;
  const f = fixture({
    contract: makeContract((_context, numerator, denominator) => ({
      quotient: numerator / denominator + (calls++ === 0 ? 0n : 1n),
      remainder: numerator % denominator,
    })),
  });
  const marked = publish(f, f.state, 90_000n * BTC_PRICE_SCALE, 2n);
  assert.throws(() => riskClose(f, stateOf(marked)), /INVALID_DIVISION_WITNESS/);
});
