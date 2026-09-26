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
  encodeZswapLocalState,
  sampleContractAddress,
} from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { sampleCoinPublicKey } from '@midnight-ntwrk/midnight-js-protocol/ledger';

const spikeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = resolve(spikeDir, 'generated/integrated_risk_custody/contract/index.js');
if (!existsSync(contractPath)) throw new Error('Run npm test to compile the integrated custody spike first.');
const Integrated = await import(contractPath);

const NETWORK_DOMAIN = new Uint8Array(32).fill(17);
const ORACLE_SECRET = new Uint8Array(32).fill(27);
const OPERATOR_SECRET = new Uint8Array(32).fill(37);
const OWNER_SECRET = new Uint8Array(32).fill(47);
const ATTACKER_SECRET = new Uint8Array(32).fill(57);
const POSITION_SALT = new Uint8Array(32).fill(67);
const RECIPIENT_SALT = new Uint8Array(32).fill(77);
const NOW = 1_000n;
const PRICE_SCALE = 1_000_000n;
const LOT = 1_000_000_000n;
const TERMS = {
  isLong: true,
  notionalAtoms: 5_000_000_000n,
  entryPriceTicks: 100_000n * PRICE_SCALE,
  guardBufferAtoms: 255_000_000n,
};
type PositionTerms = {
  isLong: boolean;
  notionalAtoms: bigint;
  entryPriceTicks: bigint;
  guardBufferAtoms: bigint;
};
type OwnerTarget = {
  ownerRecipient: { bytes: Uint8Array };
  recipientSalt: Uint8Array;
};

function makeContract(division = (_context: unknown, numerator: bigint, denominator: bigint) => ({
  quotient: numerator / denominator,
  remainder: numerator % denominator,
})) {
  return new Integrated.Contract({
    quotientRemainder(context: { privateState: unknown }, numerator: bigint, denominator: bigint) {
      return [context.privateState, division(context, numerator, denominator)];
    },
  });
}

type Fixture = {
  contract: ReturnType<typeof makeContract>;
  ownerKey: ReturnType<typeof sampleCoinPublicKey>;
  operatorKey: ReturnType<typeof sampleCoinPublicKey>;
  attackerKey: ReturnType<typeof sampleCoinPublicKey>;
  address: ReturnType<typeof sampleContractAddress>;
  oracleSecret: Uint8Array;
  operatorSecret: Uint8Array;
  ownerSecret: Uint8Array;
  terms: PositionTerms;
  ownerTarget: OwnerTarget;
  state: unknown;
};

function stateOf(result: { context: { currentQueryContext: { state: unknown } } }) {
  return result.context.currentQueryContext.state;
}

function ledger(state: unknown) {
  return Integrated.ledger((state as { data?: unknown }).data ?? state);
}

function context(
  f: Pick<Fixture, 'address' | 'ownerKey'>,
  state: unknown,
  key: unknown = f.ownerKey,
  zswap = {},
  now = NOW,
) {
  return createCircuitContext(
    f.address,
    key as never,
    state as never,
    zswap,
    undefined,
    undefined,
    Number(now),
  );
}

function fixture(options: {
  contract?: ReturnType<typeof makeContract>;
  terms?: PositionTerms;
  initialPrice?: bigint;
  oracleSecret?: Uint8Array;
  operatorSecret?: Uint8Array;
  ownerSecret?: Uint8Array;
  coinValue?: bigint;
  coinColor?: Uint8Array;
} = {}): Fixture {
  const contract = options.contract ?? makeContract();
  const ownerKey = sampleCoinPublicKey();
  const operatorKey = sampleCoinPublicKey();
  const attackerKey = sampleCoinPublicKey();
  const address = sampleContractAddress();
  const oracleSecret = options.oracleSecret ?? ORACLE_SECRET;
  const operatorSecret = options.operatorSecret ?? OPERATOR_SECRET;
  const ownerSecret = options.ownerSecret ?? OWNER_SECRET;
  const terms = options.terms ?? TERMS;
  const publisherCommitment = Integrated.pureCircuits.deriveOraclePublisherCommitment(
    NETWORK_DOMAIN,
    oracleSecret,
  );
  const initial = contract.initialState(
    createConstructorContext({}, ownerKey),
    NETWORK_DOMAIN,
    publisherCommitment,
  );
  const f = {
    contract,
    ownerKey,
    operatorKey,
    attackerKey,
    address,
    oracleSecret,
    operatorSecret,
    ownerSecret,
    terms,
  };
  const quote = contract.circuits.publishOracleQuote(
    context(f, initial.currentContractState),
    options.initialPrice ?? 100_000n * PRICE_SCALE,
    1n,
    NOW,
    oracleSecret,
  );
  const minted = contract.circuits.mintTestCollateral(
    context(f, stateOf(quote)),
    new Uint8Array(32).fill(87),
  );
  const coin = {
    ...minted.result,
    value: options.coinValue ?? minted.result.value,
    color: options.coinColor ?? minted.result.color,
  };
  const incoming = encodeZswapLocalState({
    coinPublicKey: ownerKey,
    currentIndex: 97n,
    inputs: [],
    outputs: [{
      coinInfo: {
        type: decodeRawTokenType(coin.color),
        nonce: Buffer.from(coin.nonce).toString('hex'),
        value: coin.value,
      },
      recipient: { is_left: false, left: ownerKey, right: address },
    }],
  });
  const ownerTarget = {
    ownerRecipient: { bytes: encodeCoinPublicKey(ownerKey) },
    recipientSalt: RECIPIENT_SALT,
  };
  const operatorIdentityCommitment = Integrated.pureCircuits.deriveOperatorIdentityCommitment(
    NETWORK_DOMAIN,
    encodeAddress(address),
    operatorSecret,
  );
  const opened = contract.circuits.openPosition(
    context(f, stateOf(quote), incoming),
    coin,
    terms,
    POSITION_SALT,
    ownerSecret,
    operatorIdentityCommitment,
    ownerTarget,
  );
  return {
    ...f,
    ownerTarget,
    state: stateOf(opened),
  };
}

function encodeAddress(address: ReturnType<typeof sampleContractAddress>) {
  return IntegratedRuntime.encodeContractAddress(address);
}

function publish(
  f: Fixture,
  state: unknown,
  price: bigint,
  sequence: bigint,
  now = NOW,
  publishedAt = now,
  secret = f.oracleSecret,
) {
  return f.contract.circuits.publishOracleQuote(
    context(f, state, f.ownerKey, {}, now),
    price,
    sequence,
    publishedAt,
    secret,
  );
}

function riskClose(
  f: Fixture,
  state: unknown,
  options: { terms?: PositionTerms; secret?: Uint8Array; now?: bigint } = {},
) {
  return f.contract.circuits.riskClose(
    context(f, state, f.operatorKey, {}, options.now ?? NOW),
    options.terms ?? f.terms,
    POSITION_SALT,
    options.secret ?? f.operatorSecret,
  );
}

function ownerClaim(
  f: Fixture,
  state: unknown,
  options: { terms?: PositionTerms; secret?: Uint8Array; ownerTarget?: OwnerTarget } = {},
) {
  return f.contract.circuits.ownerClaim(
    context(f, state),
    options.terms ?? f.terms,
    POSITION_SALT,
    options.secret ?? f.ownerSecret,
    options.ownerTarget ?? f.ownerTarget,
  );
}

const IntegratedRuntime = await import('@midnight-ntwrk/midnight-js-protocol/compact-runtime');

test('open commits private terms and capabilities while escrowing exactly one fixed test lot', () => {
  const f = fixture();
  const publicState = ledger(f.state);
  assert.equal(publicState.positionActive, true);
  assert.equal(publicState.escrowCoin.value, LOT);
  assert.equal(publicState.positionEntryOraclePriceTicks, TERMS.entryPriceTicks);
  assert.equal(publicState.positionEntryOracleSequence, 1n);
  assert.equal(publicState.positionEntryOraclePublishedAt, NOW);
  assert.notDeepEqual(publicState.positionCommitment, new Uint8Array(32));

  const raw = publicState as unknown as Record<string, unknown>;
  for (const field of ['terms', 'isLong', 'notionalAtoms', 'entryPriceTicks', 'guardBufferAtoms', 'ownerSecret', 'operatorSecret']) {
    assert.equal(field in raw, false, `public ledger must not contain ${field}`);
  }
  const serializedPublicLedger = JSON.stringify(publicState, (_key, value) =>
    typeof value === 'bigint'
      ? value.toString()
      : value instanceof Uint8Array
        ? Buffer.from(value).toString('hex')
        : value,
  );
  assert.equal(serializedPublicLedger.includes(TERMS.notionalAtoms.toString()), false);
  assert.equal(serializedPublicLedger.includes(TERMS.guardBufferAtoms.toString()), false);
  for (const secret of [OWNER_SECRET, OPERATOR_SECRET, ORACLE_SECRET, POSITION_SALT, RECIPIENT_SALT]) {
    assert.equal(serializedPublicLedger.includes(Buffer.from(secret).toString('hex')), false);
  }
  assert.equal(typeof f.contract.circuits.ownerClose, 'undefined', 'no self-close full-refund bypass is exposed');
});

test('P90 private protective predicate closes into ClosedUnclaimed without a public mode or token output', () => {
  const f = fixture();
  const marked = publish(f, f.state, 90_000n * PRICE_SCALE, 2n);
  const closed = riskClose(f, stateOf(marked));
  const state = ledger(stateOf(closed));
  const outputs = decodeZswapLocalState(closed.context.currentZswapLocalState).outputs;
  assert.deepEqual(closed.result, []);
  assert.equal(state.positionActive, false);
  assert.equal(state.closedUnclaimed, true);
  assert.equal(state.settled, false);
  assert.equal(state.escrowCoin.value, LOT);
  assert.equal(state.positionEntryOraclePriceTicks, TERMS.entryPriceTicks);
  assert.equal(state.positionEntryOracleSequence, 1n);
  assert.deepEqual(outputs, []);
  assert.equal('riskMode' in state, false);
  assert.equal('liquidatable' in state, false);
  assert.equal('protective' in state, false);
});

test('P84 liquidation predicate uses the same output-free close and leaves fixed collateral escrowed', () => {
  const f = fixture();
  const marked = publish(f, f.state, 84_000n * PRICE_SCALE, 2n);
  const closed = riskClose(f, stateOf(marked));
  assert.equal(ledger(stateOf(closed)).closedUnclaimed, true);
  assert.equal(ledger(stateOf(closed)).escrowCoin.value, LOT);
  assert.deepEqual(decodeZswapLocalState(closed.context.currentZswapLocalState).outputs, []);
});

test('healthy position, wrong operator preimage, and changed guard cannot close', () => {
  const f = fixture();
  const healthy = publish(f, f.state, 99_000n * PRICE_SCALE, 2n);
  assert.throws(() => riskClose(f, stateOf(healthy)), /POSITION_HEALTHY/);
  assert.throws(
    () => riskClose(f, stateOf(healthy), { secret: f.ownerSecret }),
    /NOT_AUTHORIZED_OPERATOR/,
  );
  const badTerms = { ...TERMS, guardBufferAtoms: TERMS.guardBufferAtoms - 1n };
  const losing = publish(f, f.state, 90_000n * PRICE_SCALE, 2n);
  assert.throws(() => riskClose(f, stateOf(losing), { terms: badTerms }), /POSITION_WITNESS_MISMATCH/);
  assert.equal(ledger(stateOf(healthy)).positionActive, true);
});

test('oracle rejects a forged publisher, replayed sequence, regressed timestamp, and stale snapshot', () => {
  const f = fixture();
  assert.throws(
    () => publish(f, f.state, 90_000n * PRICE_SCALE, 2n, NOW, NOW, new Uint8Array(32).fill(88)),
    /UNAUTHORIZED_ORACLE_PUBLISHER/,
  );
  assert.throws(() => publish(f, f.state, 90_000n * PRICE_SCALE, 1n), /ORACLE_SEQUENCE_NOT_NEWER/);
  assert.throws(
    () => publish(f, f.state, 90_000n * PRICE_SCALE, 2n, NOW, NOW - 1n),
    /ORACLE_TIMESTAMP_NOT_MONOTONIC/,
  );
  assert.throws(
    () => publish(f, f.state, 90_000n * PRICE_SCALE, 2n, NOW + 61n, NOW),
    /ORACLE_STALE/,
  );
  assert.doesNotThrow(
    () => publish(f, f.state, 90_000n * PRICE_SCALE, 2n, NOW + 60n, NOW),
  );
  assert.equal(ledger(f.state).oracleSequence, 1n);
});

test('risk close refuses an oracle snapshot that became stale after publication', () => {
  const f = fixture();
  const marked = publish(f, f.state, 90_000n * PRICE_SCALE, 2n);
  assert.throws(
    () => riskClose(f, stateOf(marked), { now: NOW + 61n }),
    /ORACLE_STALE/,
  );
  assert.equal(ledger(stateOf(marked)).positionActive, true);
});

test('entry guard already met at initial price is rejected before custody', () => {
  assert.throws(
    () => fixture({ terms: { ...TERMS, guardBufferAtoms: 730_000_000n } }),
    /GUARD_TRIGGERS_AT_ENTRY/,
  );
});

test('open accepts only the exact fixed collateral token and lot', () => {
  assert.throws(() => fixture({ coinValue: LOT + 1n }), /INVALID_COLLATERAL_AMOUNT/);
  assert.throws(
    () => fixture({ coinColor: new Uint8Array(32).fill(99) }),
    /INVALID_COLLATERAL_TOKEN/,
  );
});

test('ownerClaim needs owner secret after operator close and cannot substitute the committed recipient', () => {
  const f = fixture();
  const marked = publish(f, f.state, 90_000n * PRICE_SCALE, 2n);
  const closed = riskClose(f, stateOf(marked));
  const closedState = stateOf(closed);
  assert.throws(
    () => ownerClaim(f, closedState, { secret: OPERATOR_SECRET }),
    /NOT_POSITION_OWNER/,
  );
  const wrongKey = {
    ownerRecipient: { bytes: encodeCoinPublicKey(f.attackerKey) },
    recipientSalt: RECIPIENT_SALT,
  };
  assert.throws(
    () => ownerClaim(f, closedState, { ownerTarget: wrongKey }),
    /OWNER_RECIPIENT_MISMATCH/,
  );
  assert.equal(ledger(closedState).closedUnclaimed, true);
});

test('duplicate risk close and duplicate claim are rejected; owner receives only the committed fixed lot', () => {
  const f = fixture();
  const marked = publish(f, f.state, 90_000n * PRICE_SCALE, 2n);
  const closed = riskClose(f, stateOf(marked));
  const closedState = stateOf(closed);
  assert.throws(() => riskClose(f, closedState), /POSITION_NOT_OPEN/);

  const claimed = ownerClaim(f, closedState);
  const state = ledger(stateOf(claimed));
  const outputs = decodeZswapLocalState(claimed.context.currentZswapLocalState).outputs;
  assert.equal(state.positionActive, false);
  assert.equal(state.closedUnclaimed, false);
  assert.equal(state.settled, true);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]?.coinInfo.value, LOT);
  assert.equal(outputs[0]?.recipient.is_left, true);
  assert.deepEqual(
    encodeCoinPublicKey(outputs[0]!.recipient.left),
    encodeCoinPublicKey(f.ownerKey),
  );
  assert.throws(() => ownerClaim(f, stateOf(claimed)), /POSITION_NOT_CLOSED/);
});

test('wrong owner secret cannot open a claim after risk-close', () => {
  const f = fixture();
  const marked = publish(f, f.state, 90_000n * PRICE_SCALE, 2n);
  const closed = riskClose(f, stateOf(marked));
  assert.throws(
    () => ownerClaim(f, stateOf(closed), { secret: ATTACKER_SECRET }),
    /NOT_POSITION_OWNER/,
  );
});

test('risk decision rejects a forged quotient/remainder witness without changing custody state', () => {
  let witnessCalls = 0;
  const f = fixture({
    contract: makeContract((_context, numerator, denominator) => {
      const offset = witnessCalls++ === 0 ? 0n : 1n;
      return {
        quotient: numerator / denominator + offset,
        remainder: numerator % denominator,
      };
    }),
  });
  const marked = publish(f, f.state, 90_000n * PRICE_SCALE, 2n);
  const markedState = stateOf(marked);
  assert.throws(() => riskClose(f, markedState), /INVALID_DIVISION_WITNESS/);
  assert.equal(ledger(markedState).positionActive, true);
  assert.equal(ledger(markedState).escrowCoin.value, LOT);
});
