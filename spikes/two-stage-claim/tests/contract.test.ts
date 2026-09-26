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
  encodeCoinPublicKey,
  encodeContractAddress,
  encodeZswapLocalState,
  sampleContractAddress,
  decodeZswapLocalState,
} from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { sampleCoinPublicKey } from '@midnight-ntwrk/midnight-js-protocol/ledger';

const spikeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = resolve(spikeDir, 'generated/two_stage_claim/contract/index.js');
if (!existsSync(contractPath)) throw new Error('Compile the two-stage claim spike first.');
const Claim = await import(contractPath);

const LOT_ATOMS = 1_000_000_000n;
const NETWORK_DOMAIN = new Uint8Array(32).fill(47);
const TERMS = {
  side: true,
  notionalAtoms: 4_000_000_000n,
  entryPriceTicks: 65_000_000_000n,
  guardBufferAtoms: 20_000_000n,
};
const POSITION_SALT = new Uint8Array(32).fill(53);
const OWNER_SECRET = new Uint8Array(32).fill(59);
const OPERATOR_SECRET = new Uint8Array(32).fill(61);
const RECIPIENT_SALT = new Uint8Array(32).fill(67);

function ledger(state: unknown) {
  return Claim.ledger((state as { data?: unknown }).data ?? state);
}

function closeContext(address: ReturnType<typeof sampleContractAddress>, publicKey: ReturnType<typeof sampleCoinPublicKey>, state: unknown) {
  return createCircuitContext(address, publicKey, state as never, {});
}

function scenario() {
  const ownerPublicKey = sampleCoinPublicKey();
  const operatorPublicKey = sampleCoinPublicKey();
  const attackerPublicKey = sampleCoinPublicKey();
  const contractAddress = sampleContractAddress();
  const contract = new Claim.Contract({});
  const constructor = contract.initialState(
    createConstructorContext({}, ownerPublicKey),
    NETWORK_DOMAIN,
  );
  const minted = contract.circuits.mintTestCollateral(
    createCircuitContext(contractAddress, ownerPublicKey, constructor.currentContractState, {}),
    new Uint8Array(32).fill(71),
  );
  const coin = minted.result;
  const incoming = encodeZswapLocalState({
    coinPublicKey: ownerPublicKey,
    currentIndex: 73n,
    inputs: [],
    outputs: [{
      coinInfo: {
        type: decodeRawTokenType(coin.color),
        nonce: Buffer.from(coin.nonce).toString('hex'),
        value: coin.value,
      },
      recipient: { is_left: false, left: ownerPublicKey, right: contractAddress },
    }],
  });
  const ownerTarget = {
    ownerRecipient: { bytes: encodeCoinPublicKey(ownerPublicKey) },
    recipientSalt: RECIPIENT_SALT,
  };
  const operatorIdentity = Claim.pureCircuits.deriveOperatorIdentity(
    NETWORK_DOMAIN,
    encodeContractAddress(contractAddress),
    OPERATOR_SECRET,
  );
  const opened = contract.circuits.openPosition(
    createCircuitContext(contractAddress, incoming, constructor.currentContractState, {}),
    coin,
    TERMS,
    POSITION_SALT,
    OWNER_SECRET,
    operatorIdentity,
    ownerTarget,
  );
  return {
    contract,
    contractAddress,
    ownerPublicKey,
    operatorPublicKey,
    attackerPublicKey,
    ownerTarget,
    operatorIdentity,
    coin,
    state: opened.context.currentQueryContext.state,
  };
}

function operatorClose(fixture: ReturnType<typeof scenario>, secret = OPERATOR_SECRET, publicKey = fixture.operatorPublicKey) {
  return fixture.contract.circuits.operatorClose(
    closeContext(fixture.contractAddress, publicKey, fixture.state),
    secret,
  );
}

function claim(fixture: ReturnType<typeof scenario>, state: unknown, secret = OWNER_SECRET, recipient = fixture.ownerTarget) {
  return fixture.contract.circuits.ownerClaim(
    closeContext(fixture.contractAddress, fixture.ownerPublicKey, state),
    TERMS,
    POSITION_SALT,
    secret,
    recipient,
  );
}

test('operator close changes Open to ClosedUnclaimed without creating a payout', () => {
  const fixture = scenario();
  const closed = operatorClose(fixture);
  const publicState = ledger(closed.context.currentQueryContext.state);
  const txOutputs = decodeZswapLocalState(closed.context.currentZswapLocalState).outputs;

  assert.deepEqual(closed.result, []);
  assert.equal(publicState.positionActive, false);
  assert.equal(publicState.closedUnclaimed, true);
  assert.equal(publicState.settled, false);
  assert.equal(publicState.escrowCoin.value, LOT_ATOMS);
  assert.deepEqual(txOutputs, [], 'operator transaction must not send or redirect collateral');
});

test('wrong operator capability cannot close the position or change state', () => {
  const fixture = scenario();
  assert.throws(
    () => operatorClose(fixture, new Uint8Array(32).fill(79)),
    /NOT_AUTHORIZED_OPERATOR/,
  );
  assert.equal(ledger(fixture.state).positionActive, true);
  assert.equal(ledger(fixture.state).closedUnclaimed, false);
});

test('operator identity is not accepted as owner claim authority', () => {
  const fixture = scenario();
  const closed = operatorClose(fixture);
  assert.throws(
    () => claim(fixture, closed.context.currentQueryContext.state, OPERATOR_SECRET),
    /NOT_POSITION_OWNER/,
  );
  assert.equal(ledger(closed.context.currentQueryContext.state).closedUnclaimed, true);
});

test('owner claim rejects a substituted shielded recipient', () => {
  const fixture = scenario();
  const closed = operatorClose(fixture);
  const substitutedTarget = {
    ownerRecipient: { bytes: encodeCoinPublicKey(fixture.attackerPublicKey) },
    recipientSalt: RECIPIENT_SALT,
  };
  assert.throws(
    () => claim(fixture, closed.context.currentQueryContext.state, OWNER_SECRET, substitutedTarget),
    /OWNER_RECIPIENT_MISMATCH/,
  );
});

test('wrong owner secret cannot claim funds after an authorized close', () => {
  const fixture = scenario();
  const closed = operatorClose(fixture);
  assert.throws(
    () => claim(fixture, closed.context.currentQueryContext.state, new Uint8Array(32).fill(83)),
    /NOT_POSITION_OWNER/,
  );
});

test('duplicate operator close is rejected while funds remain unclaimed', () => {
  const fixture = scenario();
  const closed = operatorClose(fixture);
  assert.throws(
    () => fixture.contract.circuits.operatorClose(
      closeContext(fixture.contractAddress, fixture.operatorPublicKey, closed.context.currentQueryContext.state),
      OPERATOR_SECRET,
    ),
    /POSITION_NOT_OPEN/,
  );
});

test('owner later claims exactly the committed lot to the committed shielded recipient once', () => {
  const fixture = scenario();
  const closed = operatorClose(fixture);
  const claimed = claim(fixture, closed.context.currentQueryContext.state);
  const state = ledger(claimed.context.currentQueryContext.state);
  const outputs = decodeZswapLocalState(claimed.context.currentZswapLocalState).outputs;

  assert.deepEqual(claimed.result, []);
  assert.equal(state.positionActive, false);
  assert.equal(state.closedUnclaimed, false);
  assert.equal(state.settled, true);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]?.coinInfo.value, LOT_ATOMS);
  assert.equal(outputs[0]?.recipient.is_left, true);
  assert.deepEqual(encodeCoinPublicKey(outputs[0]!.recipient.left), encodeCoinPublicKey(fixture.ownerPublicKey));
  assert.throws(
    () => claim(fixture, claimed.context.currentQueryContext.state),
    /POSITION_NOT_CLOSED/,
  );
});

test('owner claim rejects modified committed terms', () => {
  const fixture = scenario();
  const closed = operatorClose(fixture);
  const changedTerms = { ...TERMS, notionalAtoms: TERMS.notionalAtoms + 1n };
  assert.throws(
    () => fixture.contract.circuits.ownerClaim(
      closeContext(fixture.contractAddress, fixture.ownerPublicKey, closed.context.currentQueryContext.state),
      changedTerms,
      POSITION_SALT,
      OWNER_SECRET,
      fixture.ownerTarget,
    ),
    /POSITION_WITNESS_MISMATCH/,
  );
});

test('opening stores only the operator capability commitment', () => {
  const fixture = scenario();
  const publicState = ledger(fixture.state);
  assert.deepEqual(publicState.operatorIdentityCommitment, fixture.operatorIdentity);
  assert.notDeepEqual(publicState.operatorIdentityCommitment, new Uint8Array(32));
  assert.notDeepEqual(publicState.ownerIdentityCommitment, publicState.operatorIdentityCommitment);
  assert.throws(
    () => fixture.contract.circuits.operatorClose(
      closeContext(fixture.contractAddress, fixture.operatorPublicKey, fixture.state),
      OWNER_SECRET,
    ),
    /NOT_AUTHORIZED_OPERATOR/,
  );
});
