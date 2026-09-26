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
const contractPath = resolve(spikeDir, 'generated/lp_claim_discriminator/contract/index.js');
if (!existsSync(contractPath)) throw new Error('Compile the LP claim discriminator spike first.');
const Discriminator = await import(contractPath);

const COLLATERAL = 1000n;
const PARTIAL_PAYOUT = 800n;
const CHANGE = COLLATERAL - PARTIAL_PAYOUT;

function makeZswapInput(
  coin: { color: Uint8Array; nonce: Uint8Array; value: bigint },
  caller: unknown,
  address: unknown,
) {
  return encodeZswapLocalState({
    coinPublicKey: caller as never,
    currentIndex: 84n,
    inputs: [],
    outputs: [{
      coinInfo: {
        type: decodeRawTokenType(coin.color),
        nonce: Buffer.from(coin.nonce).toString('hex'),
        value: coin.value,
      },
      recipient: { is_left: false, left: caller as never, right: address as never },
    }],
  });
}

function fixture() {
  const owner = sampleCoinPublicKey();
  const contractAddress = sampleContractAddress();
  const contract = new Discriminator.Contract({});
  const initial = contract.initialState(createConstructorContext({}, owner));
  const minted = contract.circuits.mintTestCoin(
    createCircuitContext(contractAddress, owner, initial.currentContractState, {}),
    COLLATERAL,
    new Uint8Array(32).fill(91),
  ).result;
  const opened = contract.circuits.openCollateral(
    createCircuitContext(
      contractAddress,
      makeZswapInput(minted, owner, contractAddress) as never,
      initial.currentContractState as never,
      {},
    ),
    minted,
  );
  return { contract, contractAddress, owner, state: opened.context.currentQueryContext.state };
}

function ledger(state: unknown) {
  return Discriminator.ledger((state as { data?: unknown }).data ?? state);
}

function outputs(result: { context: { currentZswapLocalState: unknown } }) {
  return decodeZswapLocalState(result.context.currentZswapLocalState as never).outputs;
}

function claim(f: ReturnType<typeof fixture>, circuit: string, payoutUnits?: bigint) {
  const recipient = { bytes: encodeCoinPublicKey(f.owner) };
  return f.contract.circuits[circuit](
    createCircuitContext(f.contractAddress, f.owner, f.state as never, {}),
    ...(payoutUnits === undefined ? [recipient] : [payoutUnits, recipient]),
  );
}

test('A: full payout spends the committed input without a change coin', () => {
  const f = fixture();
  const paid = claim(f, 'claimFullPayout');
  const txOutputs = outputs(paid);
  assert.equal(txOutputs.length, 1);
  assert.equal(txOutputs[0]?.coinInfo.value, COLLATERAL);
  assert.equal(txOutputs[0]?.recipient.is_left, true);
  const state = ledger(paid.context.currentQueryContext.state);
  assert.equal(state.settled, true);
  assert.equal(state.changeStored, false);
});

test('B: partial send emits change to contract without a ledger write', () => {
  const f = fixture();
  const paid = claim(f, 'claimPartialWithoutLedgerWrite');
  const txOutputs = outputs(paid);
  assert.equal(txOutputs.length, 2);
  assert.deepEqual(txOutputs.map((output) => output.coinInfo.value).sort((a, b) => a < b ? -1 : 1), [CHANGE, PARTIAL_PAYOUT]);
  assert.equal(txOutputs.find((output) => !output.recipient.is_left)?.coinInfo.value, CHANGE);
  const state = ledger(paid.context.currentQueryContext.state);
  assert.equal(state.settled, true);
  assert.equal(state.changeStored, false);
});

test('C: the same partial send stores its contract change in a QSCI ledger cell', () => {
  const f = fixture();
  const paid = claim(f, 'claimPartialWithLedgerWrite');
  const txOutputs = outputs(paid);
  assert.equal(txOutputs.length, 2);
  assert.deepEqual(txOutputs.map((output) => output.coinInfo.value).sort((a, b) => a < b ? -1 : 1), [CHANGE, PARTIAL_PAYOUT]);
  const state = ledger(paid.context.currentQueryContext.state);
  assert.equal(state.settled, true);
  assert.equal(state.changeStored, true);
  assert.equal(state.changeCoin.value, CHANGE);
});

test('D: public variable payout selects the 800/200 change-write branch', () => {
  const f = fixture();
  const paid = claim(f, 'claimVariablePayout', PARTIAL_PAYOUT);
  const txOutputs = outputs(paid);
  assert.deepEqual(txOutputs.map((output) => output.coinInfo.value).sort((a, b) => a < b ? -1 : 1), [CHANGE, PARTIAL_PAYOUT]);
  const state = ledger(paid.context.currentQueryContext.state);
  assert.equal(state.settled, true);
  assert.equal(state.changeStored, true);
  assert.equal(state.changeCoin.value, CHANGE);
});

test('E: full trader payout leaves a separate funded reserve coin untouched', () => {
  const f = fixture();
  const reserve = f.contract.circuits.mintTestCoin(
    createCircuitContext(f.contractAddress, f.owner, f.state as never, {}),
    500n,
    new Uint8Array(32).fill(92),
  ).result;
  const funded = f.contract.circuits.fundReserve(
    createCircuitContext(
      f.contractAddress,
      makeZswapInput(reserve, f.owner, f.contractAddress) as never,
      f.state as never,
      {},
    ),
    reserve,
  );
  const paid = f.contract.circuits.claimFullWithReserve(
    createCircuitContext(f.contractAddress, f.owner, funded.context.currentQueryContext.state as never, {}),
    { bytes: encodeCoinPublicKey(f.owner) },
  );
  const state = ledger(paid.context.currentQueryContext.state);
  assert.deepEqual(outputs(paid).map((output) => output.coinInfo.value), [COLLATERAL]);
  assert.equal(state.collateralLocked, false);
  assert.equal(state.settled, true);
  assert.equal(state.reserveFunded, true);
  assert.equal(state.reserveCoin.value, 500n);
});

test('each discriminator requires collateral to have been locked first', () => {
  const f = fixture();
  assert.throws(
    () => f.contract.circuits.claimPartialWithLedgerWrite(
      createCircuitContext(f.contractAddress, f.owner, f.contract.initialState(createConstructorContext({}, f.owner)).currentContractState as never, {}),
      { bytes: encodeCoinPublicKey(f.owner) },
    ),
    /COLLATERAL_NOT_LOCKED/,
  );
});
