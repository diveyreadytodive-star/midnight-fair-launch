import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  createCircuitContext,
  createConstructorContext,
  decodeRawTokenType,
  decodeZswapLocalState,
  encodeCoinPublicKey,
  encodeContractAddress,
  encodeZswapLocalState,
  sampleContractAddress,
} from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { sampleCoinPublicKey } from '@midnight-ntwrk/midnight-js-protocol/ledger';

import {
  BASIS_POINTS,
  PRICE_TICKS_PER_USD,
  calculatePositionRisk,
  type RiskPolicy as ReferenceRiskPolicy,
} from '../../../src/risk/calculator.ts';

const spikeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = resolve(spikeDir, 'generated/perp_settlement/contract/index.js');
if (!existsSync(contractPath)) throw new Error('Run npm test to compile the settlement spike first.');
const Perp = await import(contractPath);

const NETWORK_DOMAIN = new Uint8Array(32).fill(13);
const ORACLE_SECRET = new Uint8Array(32).fill(23);
const OPERATOR_SECRET = new Uint8Array(32).fill(33);
const OWNER_SECRET = new Uint8Array(32).fill(43);
const LP_SECRET = new Uint8Array(32).fill(53);
const ATTACKER_SECRET = new Uint8Array(32).fill(63);
const POSITION_SALT = new Uint8Array(32).fill(73);
const OWNER_SALT = new Uint8Array(32).fill(83);
const LP_SALT = new Uint8Array(32).fill(93);
const NOW = 1_000n;
const ATOM = 1_000_000n;
const PRICE = PRICE_TICKS_PER_USD;
const COLLATERAL = 1_000_000_000n;
const RESERVE = 500_000_000n;
const NOTIONAL = 5_000_000_000n;
const EXIT_COST = 20_000_000n;
const PROFIT_CAP = 500_000_000n;

type Terms = {
  isLong: boolean;
  notionalAtoms: bigint;
  entryPriceTicks: bigint;
  guardBufferAtoms: bigint;
};
type OwnerTarget = { ownerRecipient: { bytes: Uint8Array }; recipientSalt: Uint8Array };
type LpTarget = { lpRecipient: { bytes: Uint8Array }; recipientSalt: Uint8Array };
type Coin = { color: Uint8Array; nonce: Uint8Array; value: bigint };

const BASE_TERMS: Terms = {
  isLong: true,
  notionalAtoms: NOTIONAL,
  entryPriceTicks: 100_000n * PRICE,
  guardBufferAtoms: 255_000_000n,
};

const REFERENCE_POLICY: ReferenceRiskPolicy = {
  minimumCollateral: ATOM,
  maximumLeverageBps: 100_000n,
  maintenanceMarginBps: 500n,
  estimatedExitCost: EXIT_COST,
  protectiveBuffer: BASE_TERMS.guardBufferAtoms,
  profitPayoutCap: PROFIT_CAP,
  riskSlotLiability: PROFIT_CAP,
  availableRiskReserve: PROFIT_CAP,
};

function makeContract(division = (_context: unknown, numerator: bigint, denominator: bigint) => ({
  quotient: numerator / denominator,
  remainder: numerator % denominator,
})) {
  return new Perp.Contract({
    quotientRemainder(context: { privateState: unknown }, numerator: bigint, denominator: bigint) {
      return [context.privateState, division(context, numerator, denominator)];
    },
  });
}

function context(
  address: ReturnType<typeof sampleContractAddress>,
  state: unknown,
  caller: unknown,
  zswap = {},
  now = NOW,
) {
  return createCircuitContext(address, caller as never, state as never, zswap, undefined, undefined, Number(now));
}

function stateOf(result: { context: { currentQueryContext: { state: unknown } } }) {
  return result.context.currentQueryContext.state;
}

function ledger(state: unknown) {
  return Perp.ledger((state as { data?: unknown }).data ?? state);
}

function outputs(result: { context: { currentZswapLocalState: unknown } }) {
  return decodeZswapLocalState(result.context.currentZswapLocalState as never).outputs;
}

function zswapInput(coin: Coin, caller: ReturnType<typeof sampleCoinPublicKey>, address: ReturnType<typeof sampleContractAddress>) {
  return encodeZswapLocalState({
    coinPublicKey: caller,
    currentIndex: 117n,
    inputs: [],
    outputs: [{
      coinInfo: {
        type: decodeRawTokenType(coin.color),
        nonce: Buffer.from(coin.nonce).toString('hex'),
        value: coin.value,
      },
      recipient: { is_left: false, left: caller, right: address },
    }],
  });
}

function scenario(options: {
  terms?: Terms;
  initialMark?: bigint;
  contract?: ReturnType<typeof makeContract>;
} = {}) {
  const contract = options.contract ?? makeContract();
  const ownerKey = sampleCoinPublicKey();
  const operatorKey = sampleCoinPublicKey();
  const lpKey = sampleCoinPublicKey();
  const attackerKey = sampleCoinPublicKey();
  const address = sampleContractAddress();
  const terms = options.terms ?? BASE_TERMS;
  const ownerTarget: OwnerTarget = { ownerRecipient: { bytes: encodeCoinPublicKey(ownerKey) }, recipientSalt: OWNER_SALT };
  const lpTarget: LpTarget = { lpRecipient: { bytes: encodeCoinPublicKey(lpKey) }, recipientSalt: LP_SALT };
  const oracleCommitment = Perp.pureCircuits.deriveOraclePublisherCommitment(NETWORK_DOMAIN, ORACLE_SECRET);
  const lpIdentityCommitment = Perp.pureCircuits.deriveLpIdentityCommitment(NETWORK_DOMAIN, LP_SECRET);
  const initial = contract.initialState(createConstructorContext({}, ownerKey), NETWORK_DOMAIN, oracleCommitment, lpIdentityCommitment);
  const base = { contract, ownerKey, operatorKey, lpKey, attackerKey, address, terms, ownerTarget, lpTarget };

  const reserve = contract.circuits.mintTestCoin(
    context(address, initial.currentContractState, lpKey),
    RESERVE,
    new Uint8Array(32).fill(101),
  ).result as Coin;
  const funded = contract.circuits.fundReserve(
    context(address, initial.currentContractState, lpKey, zswapInput(reserve, lpKey, address)),
    reserve,
    LP_SECRET,
    lpTarget,
  );
  const published = contract.circuits.publishOracleQuote(
    context(address, stateOf(funded), ownerKey),
    options.initialMark ?? terms.entryPriceTicks,
    1n,
    NOW,
    ORACLE_SECRET,
  );
  const collateral = contract.circuits.mintTestCoin(
    context(address, stateOf(published), ownerKey),
    COLLATERAL,
    new Uint8Array(32).fill(111),
  ).result as Coin;
  const operatorIdentity = Perp.pureCircuits.deriveOperatorIdentityCommitment(
    NETWORK_DOMAIN,
    encodeContractAddress(address),
    OPERATOR_SECRET,
  );
  const opened = contract.circuits.openPosition(
    context(address, stateOf(published), ownerKey, zswapInput(collateral, ownerKey, address)),
    collateral,
    terms,
    POSITION_SALT,
    OWNER_SECRET,
    operatorIdentity,
    ownerTarget,
  );
  return {
    ...base,
    operatorIdentity,
    state: stateOf(opened),
    collateral,
    reserve,
  };
}

function reserveOnly() {
  const contract = makeContract();
  const lpKey = sampleCoinPublicKey();
  const attackerKey = sampleCoinPublicKey();
  const address = sampleContractAddress();
  const oracleCommitment = Perp.pureCircuits.deriveOraclePublisherCommitment(NETWORK_DOMAIN, ORACLE_SECRET);
  const lpIdentityCommitment = Perp.pureCircuits.deriveLpIdentityCommitment(NETWORK_DOMAIN, LP_SECRET);
  const initial = contract.initialState(createConstructorContext({}, lpKey), NETWORK_DOMAIN, oracleCommitment, lpIdentityCommitment);
  const lpTarget: LpTarget = { lpRecipient: { bytes: encodeCoinPublicKey(lpKey) }, recipientSalt: LP_SALT };
  const coin = contract.circuits.mintTestCoin(
    context(address, initial.currentContractState, lpKey),
    RESERVE,
    new Uint8Array(32).fill(117),
  ).result as Coin;
  const funded = contract.circuits.fundReserve(
    context(address, initial.currentContractState, lpKey, zswapInput(coin, lpKey, address)),
    coin,
    LP_SECRET,
    lpTarget,
  );
  return { contract, lpKey, attackerKey, address, lpTarget, state: stateOf(funded) };
}

function publish(
  f: ReturnType<typeof scenario>,
  state: unknown,
  price: bigint,
  seq: bigint,
  timestamp = NOW,
  secret = ORACLE_SECRET,
  now = NOW,
) {
  return f.contract.circuits.publishOracleQuote(
    context(f.address, state, f.ownerKey, {}, now),
    price,
    seq,
    timestamp,
    secret,
  );
}

function riskClose(f: ReturnType<typeof scenario>, state: unknown, secret = OPERATOR_SECRET) {
  return f.contract.circuits.riskClose(
    context(f.address, state, f.operatorKey),
    f.terms,
    POSITION_SALT,
    secret,
  );
}

function ownerSelfClose(f: ReturnType<typeof scenario>, state: unknown, secret = OWNER_SECRET) {
  return f.contract.circuits.ownerSelfClose(
    context(f.address, state, f.ownerKey),
    f.terms,
    POSITION_SALT,
    secret,
    f.ownerTarget,
  );
}

function settle(f: ReturnType<typeof scenario>, state: unknown, path: string, options: {
  terms?: Terms;
  ownerSecret?: Uint8Array;
  target?: OwnerTarget;
} = {}) {
  return f.contract.circuits[path](
    context(f.address, state, f.ownerKey),
    options.terms ?? f.terms,
    POSITION_SALT,
    options.ownerSecret ?? OWNER_SECRET,
    options.target ?? f.ownerTarget,
  );
}

function lpClaimLoss(f: ReturnType<typeof scenario>, state: unknown, options: {
  secret?: Uint8Array;
  target?: LpTarget;
} = {}) {
  return f.contract.circuits.lpClaimCollateralRemainder(
    context(f.address, state, f.lpKey),
    options.secret ?? LP_SECRET,
    options.target ?? f.lpTarget,
  );
}

function lpClaimReserve(f: ReturnType<typeof scenario>, state: unknown) {
  return f.contract.circuits.lpClaimReserveRemainder(
    context(f.address, state, f.lpKey),
    LP_SECRET,
    f.lpTarget,
  );
}

function reference(mark: bigint, terms: Terms = BASE_TERMS) {
  return calculatePositionRisk({
    side: terms.isLong ? 'long' : 'short',
    collateral: COLLATERAL,
    notional: terms.notionalAtoms,
    entryPrice: terms.entryPriceTicks,
    markPrice: mark,
    accruedBorrowFee: 0n,
    accruedFundingFee: 0n,
  }, REFERENCE_POLICY);
}

function outputValues(result: { context: { currentZswapLocalState: unknown } }) {
  return outputs(result).map((output) => output.coinInfo.value);
}

function receiverAmount(result: { context: { currentZswapLocalState: unknown } }, recipient: Uint8Array): bigint {
  return outputs(result).reduce((amount, output) => {
    if (!output.recipient.is_left) return amount;
    return encodeCoinPublicKey(output.recipient.left).toString() === recipient.toString()
      ? amount + output.coinInfo.value
      : amount;
  }, 0n);
}

test('Compact settlement preview through actual claims matches TS P90/P84 payout math in product units', () => {
  for (const [price, expectedPayout, expectedMaintenance, expectedRiskPath] of [
    [90_000n * PRICE, 480_000_000n, 225_000_000n, 'protective'] as const,
    [84_000n * PRICE, 180_000_000n, 210_000_000n, 'liquidation'] as const,
  ]) {
    const f = scenario();
    const ts = reference(price);
    assert.equal(ts.traderPayout, expectedPayout);
    assert.equal(ts.maintenance, expectedMaintenance);
    assert.equal(ts.isLiquidatable, expectedRiskPath === 'liquidation');
    assert.equal(ts.shouldProtectiveClose, expectedRiskPath === 'protective');

    const marked = publish(f, f.state, price, 2n);
    const closed = riskClose(f, stateOf(marked));
    assert.equal(ledger(stateOf(closed)).closedUnclaimed, true);
    const paid = settle(f, stateOf(closed), 'ownerSettleLoss');
    assert.equal(receiverAmount(paid, f.ownerTarget.ownerRecipient.bytes), ts.traderPayout);
    assert.equal(ledger(stateOf(paid)).settled, true);
    assert.equal(ledger(stateOf(paid)).lpCollateralRemainderCoin.value, COLLATERAL - ts.traderPayout);
    assert.equal(ledger(stateOf(paid)).reserveCoin.value, RESERVE);
  }
});

test('fixed zero-fee policy ignores caller-supplied funding-credit fields', () => {
  const attackerTerms = {
    ...BASE_TERMS,
    accruedFundingFeeAtoms: COLLATERAL,
    fundingIsCredit: true,
  } as unknown as Terms;
  const f = scenario({ terms: attackerTerms });
  const marked = publish(f, f.state, 90_000n * PRICE, 2n);
  const closed = riskClose(f, stateOf(marked));
  const paid = settle(f, stateOf(closed), 'ownerSettleLoss');
  assert.equal(reference(90_000n * PRICE, attackerTerms).traderPayout, 480_000_000n);
  assert.equal(receiverAmount(paid, f.ownerTarget.ownerRecipient.bytes), 480_000_000n);
  assert.equal(ledger(stateOf(paid)).reserveCoin.value, RESERVE);
});

test('flat settlement pays exactly collateral and rejects loss/profit selectors', () => {
  const terms = { ...BASE_TERMS, guardBufferAtoms: 255_000_000n };
  const f = scenario({ terms });
  const flatPrice = 100_000n * PRICE + 400n * PRICE;
  const ts = reference(flatPrice, terms);
  assert.equal(ts.traderPayout, COLLATERAL);
  const marked = publish(f, f.state, flatPrice, 2n);
  const selfClosed = ownerSelfClose(f, stateOf(marked));
  assert.throws(() => settle(f, stateOf(selfClosed), 'ownerSettleLoss'), /WRONG_SETTLEMENT_PATH/);
  assert.throws(() => settle(f, stateOf(selfClosed), 'ownerSettleProfit'), /WRONG_SETTLEMENT_PATH/);
  const paid = settle(f, stateOf(selfClosed), 'ownerSettleFlat');
  assert.deepEqual(outputValues(paid), [COLLATERAL]);
  assert.equal(receiverAmount(paid, f.ownerTarget.ownerRecipient.bytes), ts.traderPayout);
  assert.equal(ledger(stateOf(paid)).reserveCoin.value, RESERVE);
});

test('owner self-close at unchanged P100 cannot use the old blanket full-refund path', () => {
  const f = scenario();
  const selfClosed = ownerSelfClose(f, f.state);
  const ts = reference(BASE_TERMS.entryPriceTicks);
  assert.equal(ts.traderPayout, 980_000_000n);
  assert.throws(() => settle(f, stateOf(selfClosed), 'ownerSettleFlat'), /WRONG_SETTLEMENT_PATH/);
  const paid = settle(f, stateOf(selfClosed), 'ownerSettleLoss');
  assert.equal(receiverAmount(paid, f.ownerTarget.ownerRecipient.bytes), ts.traderPayout);
  assert.notEqual(ts.traderPayout, COLLATERAL);
});

test('profit settlement spends reserve only for computed profit and leaves a claimable remainder', () => {
  const f = scenario();
  const ts = reference(110_000n * PRICE);
  assert.equal(ts.traderPayout, 1_480_000_000n);
  assert.equal(ts.profitPaid, 480_000_000n);
  const marked = publish(f, f.state, 110_000n * PRICE, 2n);
  const selfClosed = ownerSelfClose(f, stateOf(marked));
  assert.throws(() => settle(f, stateOf(selfClosed), 'ownerSettleLoss'), /WRONG_SETTLEMENT_PATH/);
  const paid = settle(f, stateOf(selfClosed), 'ownerSettleProfit');
  assert.equal(receiverAmount(paid, f.ownerTarget.ownerRecipient.bytes), ts.traderPayout);
  assert.equal(ledger(stateOf(paid)).reserveFunded, true);
  assert.equal(ledger(stateOf(paid)).reserveCoin.value, 20_000_000n);
  const laterLpClaim = lpClaimReserve(f, stateOf(paid));
  assert.deepEqual(outputValues(laterLpClaim), [20_000_000n]);
  assert.equal(ledger(stateOf(laterLpClaim)).reserveFunded, false);
  assert.throws(() => lpClaimReserve(f, stateOf(laterLpClaim)), /NO_LP_RESERVE_REMAINDER/);
});

test('profit cap spends no more than the funded 500m reserve', () => {
  const f = scenario();
  const ts = reference(115_000n * PRICE);
  assert.equal(ts.traderPayout, 1_500_000_000n);
  assert.equal(ts.profitPaid, RESERVE);
  const marked = publish(f, f.state, 115_000n * PRICE, 2n);
  const selfClosed = ownerSelfClose(f, stateOf(marked));
  const paid = settle(f, stateOf(selfClosed), 'ownerSettleProfit');
  assert.equal(receiverAmount(paid, f.ownerTarget.ownerRecipient.bytes), ts.traderPayout);
  assert.equal(ledger(stateOf(paid)).reserveFunded, false);
  assert.equal(ledger(stateOf(paid)).reserveCoin.value, RESERVE);
  assert.throws(() => lpClaimReserve(f, stateOf(paid)), /NO_LP_RESERVE_REMAINDER/);
});

test('bad debt reports the TS shortfall and does not spend the profit-only LP reserve', () => {
  const terms = { ...BASE_TERMS, isLong: false, guardBufferAtoms: 255_000_000n };
  const f = scenario({ terms });
  const ts = calculatePositionRisk({
    side: 'short',
    collateral: COLLATERAL,
    notional: NOTIONAL,
    entryPrice: terms.entryPriceTicks,
    markPrice: 130_000n * PRICE,
    accruedBorrowFee: 0n,
    accruedFundingFee: 0n,
  }, REFERENCE_POLICY);
  assert.equal(ts.traderPayout, 0n);
  assert.equal(ts.insuranceShortfall, 520_000_000n);
  const marked = publish(f, f.state, 130_000n * PRICE, 2n);
  const closed = riskClose(f, stateOf(marked));
  const settled = settle(f, stateOf(closed), 'ownerSettleBadDebt');
  assert.equal(receiverAmount(settled, f.ownerTarget.ownerRecipient.bytes), 0n);
  assert.equal(ledger(stateOf(settled)).lpCollateralRemainderCoin.value, COLLATERAL);
  assert.equal(ledger(stateOf(settled)).reserveCoin.value, RESERVE);
  assert.equal(ledger(stateOf(settled)).reserveFunded, true);
  const lpRecovery = lpClaimLoss(f, stateOf(settled));
  assert.deepEqual(outputValues(lpRecovery), [COLLATERAL]);
});

test('payout is frozen to the authenticated close snapshot, not a later oracle update', () => {
  const f = scenario();
  const riskQuote = publish(f, f.state, 90_000n * PRICE, 2n);
  const closed = riskClose(f, stateOf(riskQuote));
  const laterQuote = publish(f, stateOf(closed), 110_000n * PRICE, 3n);
  const paid = settle(f, stateOf(laterQuote), 'ownerSettleLoss');
  assert.equal(receiverAmount(paid, f.ownerTarget.ownerRecipient.bytes), 480_000_000n);
  assert.equal(ledger(stateOf(paid)).settlementOraclePriceTicks, 90_000n * PRICE);
  assert.equal(ledger(stateOf(paid)).oraclePriceTicks, 110_000n * PRICE);
});

test('forged/stale oracle, wrong operator, wrong owner and substituted recipient reject', () => {
  const f = scenario();
  assert.throws(
    () => publish(f, f.state, 90_000n * PRICE, 2n, NOW, new Uint8Array(32).fill(99)),
    /UNAUTHORIZED_ORACLE_PUBLISHER/,
  );
  assert.throws(() => publish(f, f.state, 90_000n * PRICE, 1n), /ORACLE_SEQUENCE_NOT_NEWER/);
  assert.throws(() => publish(f, f.state, 90_000n * PRICE, 2n, NOW, ORACLE_SECRET, NOW + 61n), /ORACLE_STALE/);
  assert.throws(() => publish(f, f.state, 90_000n * PRICE, 2n, NOW + 1n), /ORACLE_TIMESTAMP_IN_FUTURE/);
  const marked = publish(f, f.state, 90_000n * PRICE, 2n);
  assert.throws(() => riskClose(f, stateOf(marked), OWNER_SECRET), /NOT_AUTHORIZED_OPERATOR/);
  const closed = riskClose(f, stateOf(marked));
  assert.throws(() => settle(f, stateOf(closed), 'ownerSettleLoss', { ownerSecret: ATTACKER_SECRET }), /NOT_POSITION_OWNER/);
  const badTarget: OwnerTarget = {
    ownerRecipient: { bytes: encodeCoinPublicKey(f.attackerKey) },
    recipientSalt: OWNER_SALT,
  };
  assert.throws(() => settle(f, stateOf(closed), 'ownerSettleLoss', { target: badTarget }), /OWNER_RECIPIENT_MISMATCH/);
  assert.equal(ledger(stateOf(closed)).closedUnclaimed, true);
});

test('reserve and owner remainder claims are at-most-once and require their committed LP authority', () => {
  const f = scenario();
  const marked = publish(f, f.state, 90_000n * PRICE, 2n);
  const closed = riskClose(f, stateOf(marked));
  const paid = settle(f, stateOf(closed), 'ownerSettleLoss');
  assert.throws(() => settle(f, stateOf(paid), 'ownerSettleLoss'), /POSITION_NOT_CLOSED/);
  assert.throws(() => lpClaimLoss(f, stateOf(paid), { secret: ATTACKER_SECRET }), /NOT_AUTHORIZED_LP/);
  const lpPaid = lpClaimLoss(f, stateOf(paid));
  assert.deepEqual(outputValues(lpPaid), [520_000_000n]);
  assert.equal(ledger(stateOf(lpPaid)).lpCollateralRemainderClaimable, false);
  assert.throws(() => lpClaimLoss(f, stateOf(lpPaid)), /NO_LP_COLLATERAL_REMAINDER/);
});

test('constructor-bound LP authority prevents a first-funder reserve hijack', () => {
  const contract = makeContract();
  const ownerKey = sampleCoinPublicKey();
  const attackerKey = sampleCoinPublicKey();
  const address = sampleContractAddress();
  const oracleCommitment = Perp.pureCircuits.deriveOraclePublisherCommitment(NETWORK_DOMAIN, ORACLE_SECRET);
  const lpCommitment = Perp.pureCircuits.deriveLpIdentityCommitment(NETWORK_DOMAIN, LP_SECRET);
  const initial = contract.initialState(
    createConstructorContext({}, ownerKey),
    NETWORK_DOMAIN,
    oracleCommitment,
    lpCommitment,
  );
  const attackerCoin = contract.circuits.mintTestCoin(
    context(address, initial.currentContractState, attackerKey),
    RESERVE,
    new Uint8Array(32).fill(121),
  ).result as Coin;
  const attackerTarget: LpTarget = {
    lpRecipient: { bytes: encodeCoinPublicKey(attackerKey) },
    recipientSalt: LP_SALT,
  };
  assert.throws(
    () => contract.circuits.fundReserve(
      context(address, initial.currentContractState, attackerKey, zswapInput(attackerCoin, attackerKey, address)),
      attackerCoin,
      ATTACKER_SECRET,
      attackerTarget,
    ),
    /NOT_AUTHORIZED_LP/,
  );
  assert.equal(ledger(initial.currentContractState).reserveFunded, false);
});

test('LP can cancel and recover reserve only before any position opens', () => {
  const f = reserveOnly();
  assert.throws(() => f.contract.circuits.cancelUnopenedReserve(
    context(f.address, f.state, f.attackerKey),
    ATTACKER_SECRET,
    { lpRecipient: { bytes: encodeCoinPublicKey(f.attackerKey) }, recipientSalt: LP_SALT },
  ), /NOT_AUTHORIZED_LP/);
  assert.equal(ledger(f.state).reserveFunded, true);
  const canceled = f.contract.circuits.cancelUnopenedReserve(
    context(f.address, f.state, f.lpKey),
    LP_SECRET,
    f.lpTarget,
  );
  assert.deepEqual(outputValues(canceled), [RESERVE]);
  assert.equal(ledger(stateOf(canceled)).reserveFunded, false);
  assert.throws(() => f.contract.circuits.cancelUnopenedReserve(
    context(f.address, stateOf(canceled), f.lpKey),
    LP_SECRET,
    f.lpTarget,
  ), /RESERVE_NOT_FUNDED/);

  const opened = scenario();
  assert.throws(() => opened.contract.circuits.cancelUnopenedReserve(
    context(opened.address, opened.state, opened.lpKey),
    LP_SECRET,
    opened.lpTarget,
  ), /RESERVE_ALREADY_COMMITTED_TO_POSITION/);
});

test('permissionless zero-payout finalizer moves bad-debt collateral to LP custody without owner secret', () => {
  const shortTerms = { ...BASE_TERMS, isLong: false };
  const f = scenario({ terms: shortTerms });
  const ts = calculatePositionRisk({
    side: 'short',
    collateral: COLLATERAL,
    notional: NOTIONAL,
    entryPrice: shortTerms.entryPriceTicks,
    markPrice: 130_000n * PRICE,
    accruedBorrowFee: 0n,
    accruedFundingFee: 0n,
  }, REFERENCE_POLICY);
  assert.equal(ts.traderPayout, 0n);
  assert.equal(ts.insuranceShortfall, 520_000_000n);
  const marked = publish(f, f.state, 130_000n * PRICE, 2n);
  const closed = riskClose(f, stateOf(marked));
  const finalized = f.contract.circuits.finalizeZeroPayout(
    context(f.address, stateOf(closed), f.attackerKey),
    shortTerms,
    POSITION_SALT,
  );
  const state = ledger(stateOf(finalized));
  assert.equal(state.positionActive, false);
  assert.equal(state.closedUnclaimed, false);
  assert.equal(state.settled, true);
  assert.equal(state.lpCollateralRemainderClaimable, true);
  assert.equal(state.lpCollateralRemainderCoin.value, COLLATERAL);
  assert.equal(state.reserveFunded, true);
  assert.equal(state.reserveCoin.value, RESERVE, 'profit-only reserve does not cover shortfall');
  assert.deepEqual(outputValues(finalized), [COLLATERAL]);

  assert.throws(() => f.contract.circuits.finalizeZeroPayout(
    context(f.address, stateOf(finalized), f.attackerKey),
    shortTerms,
    POSITION_SALT,
  ), /POSITION_NOT_CLOSED/);
  const recovered = lpClaimLoss(f, stateOf(finalized));
  assert.deepEqual(outputValues(recovered), [COLLATERAL]);
});

test('zero-payout finalizer rejects positive payout and changed position witnesses', () => {
  const f = scenario();
  const marked = publish(f, f.state, 90_000n * PRICE, 2n);
  const closed = riskClose(f, stateOf(marked));
  assert.throws(() => f.contract.circuits.finalizeZeroPayout(
    context(f.address, stateOf(closed), f.attackerKey),
    f.terms,
    POSITION_SALT,
  ), /POSITIVE_PAYOUT_REQUIRES_OWNER_CLAIM/);
  assert.throws(() => f.contract.circuits.finalizeZeroPayout(
    context(f.address, stateOf(closed), f.attackerKey),
    { ...f.terms, notionalAtoms: NOTIONAL - 1n },
    POSITION_SALT,
  ), /POSITION_TERMS_MISMATCH/);
  assert.equal(ledger(stateOf(closed)).closedUnclaimed, true);
  assert.equal(ledger(stateOf(closed)).settled, false);
});

test('static selector rejects the wrong path and accepts no caller payout argument', () => {
  const f = scenario();
  const marked = publish(f, f.state, 90_000n * PRICE, 2n);
  const closed = riskClose(f, stateOf(marked));
  assert.throws(() => settle(f, stateOf(closed), 'ownerSettleProfit'), /WRONG_SETTLEMENT_PATH/);
  assert.throws(() => f.contract.circuits.ownerSettleLoss(
    context(f.address, stateOf(closed), f.ownerKey),
    f.terms,
    POSITION_SALT,
    OWNER_SECRET,
    f.ownerTarget,
    123_000_000n,
  ), /expected 5 arguments/);
});
