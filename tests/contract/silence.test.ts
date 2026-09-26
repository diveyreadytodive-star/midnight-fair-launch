import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  createCircuitContext,
  createConstructorContext,
  decodeRawTokenType,
  encodeCoinPublicKey,
  encodeZswapLocalState,
  sampleContractAddress,
} from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { sampleCoinPublicKey } from '@midnight-ntwrk/midnight-js-protocol/ledger';

const contractPath = resolve('contracts/managed/silence/contract/index.js');
if (!existsSync(contractPath)) throw new Error('Run npm run compile before npm test.');
const Silence = await import(contractPath);

const LOT_ATOMS = 1_000_000_000n;
const NETWORK_DOMAIN = new Uint8Array(32).fill(19);
const POSITION_TERMS = {
  side: true,
  notionalAtoms: 1_234_567_890n,
  entryPriceTicks: 65_432_123_456n,
  guardBufferAtoms: 22_500_123n,
};
const POSITION_SALT = new Uint8Array(32).fill(23);
const OWNER_CLOSE_SECRET = new Uint8Array(32).fill(29);
const RECIPIENT_SALT = new Uint8Array(32).fill(31);

function openScenario(overrides: {
  terms?: typeof POSITION_TERMS;
  coinValue?: bigint;
} = {}) {
  const ownerCoinPublicKey = sampleCoinPublicKey();
  const otherCoinPublicKey = sampleCoinPublicKey();
  const contractAddress = sampleContractAddress();
  const contract = new Silence.Contract({});
  const constructor = contract.initialState(
    createConstructorContext({}, ownerCoinPublicKey),
    NETWORK_DOMAIN,
  );
  const mint = contract.circuits.mintTestCollateral(
    createCircuitContext(contractAddress, ownerCoinPublicKey, constructor.currentContractState, {}),
    new Uint8Array(32).fill(37),
  );
  const coin = { ...mint.result, value: overrides.coinValue ?? mint.result.value };
  const incomingOutput = encodeZswapLocalState({
    coinPublicKey: ownerCoinPublicKey,
    currentIndex: 41n,
    inputs: [],
    outputs: [{
      coinInfo: {
        type: decodeRawTokenType(coin.color),
        nonce: Buffer.from(coin.nonce).toString('hex'),
        value: coin.value,
      },
      recipient: {
        is_left: false,
        left: ownerCoinPublicKey,
        right: contractAddress,
      },
    }],
  });
  const ownerTarget = {
    ownerRecipient: { bytes: encodeCoinPublicKey(ownerCoinPublicKey) },
    recipientSalt: RECIPIENT_SALT,
  };
  const terms = overrides.terms ?? POSITION_TERMS;
  const committed = contract.circuits.commitPosition(
    createCircuitContext(
      contractAddress,
      incomingOutput,
      constructor.currentContractState,
      {},
    ),
    coin,
    terms,
    POSITION_SALT,
    OWNER_CLOSE_SECRET,
    ownerTarget,
  );
  return {
    contract,
    contractAddress,
    ownerCoinPublicKey,
    otherCoinPublicKey,
    ownerTarget,
    terms,
    coin,
    initialState: constructor.currentContractState,
    state: committed.context.currentQueryContext.state,
  };
}

function closeContext(
  contractAddress: ReturnType<typeof sampleContractAddress>,
  proverControlledCoinPublicKey: string,
  state: unknown,
) {
  return createCircuitContext(contractAddress, proverControlledCoinPublicKey, state as never, {});
}

function ledger(state: unknown) {
  return Silence.ledger((state as { data?: unknown }).data ?? state);
}

test('fixed public 1000-unit lot commits private terms and returns the lot once', () => {
  const scenario = openScenario();
  const publicState = ledger(scenario.state);

  assert.equal(publicState.escrowCoin.value, LOT_ATOMS);
  assert.ok(publicState.escrowCoin.mt_index > 0n);
  assert.equal(publicState.positionActive, true);
  assert.equal(publicState.settled, false);
  assert.notDeepEqual(publicState.ownerIdentityCommitment, new Uint8Array(32));
  assert.notDeepEqual(publicState.ownerRecipientCommitment, new Uint8Array(32));
  assert.notDeepEqual(publicState.positionCommitment, new Uint8Array(32));

  const keys = Object.keys(publicState);
  for (const hiddenField of [
    'side',
    'notionalAtoms',
    'entryPriceTicks',
    'guardBufferAtoms',
    'ownerCloseSecret',
    'ownerRecipient',
  ]) {
    assert.ok(!keys.includes(hiddenField), 'public ledger exposes ' + hiddenField);
  }
  const serializedState = JSON.stringify(publicState, (_key, value) => {
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
    return value;
  });
  for (const privateValue of [
    POSITION_TERMS.notionalAtoms.toString(),
    POSITION_TERMS.entryPriceTicks.toString(),
    POSITION_TERMS.guardBufferAtoms.toString(),
    Buffer.from(OWNER_CLOSE_SECRET).toString('hex'),
    Buffer.from(scenario.ownerCoinPublicKey).toString('hex'),
  ]) {
    assert.ok(!serializedState.includes(privateValue), 'public ledger contains a private opening');
  }

  const closed = scenario.contract.circuits.ownerClose(
    closeContext(scenario.contractAddress, scenario.ownerCoinPublicKey, scenario.state),
    scenario.terms,
    POSITION_SALT,
    OWNER_CLOSE_SECRET,
    scenario.ownerTarget,
  );
  assert.deepEqual(closed.result, []);
  const finalState = ledger(closed.context.currentQueryContext.state);
  assert.equal(finalState.positionActive, false);
  assert.equal(finalState.settled, true);
  assert.equal(finalState.escrowCoin.value, LOT_ATOMS);
  assert.throws(
    () => scenario.contract.circuits.ownerClose(
      closeContext(
        scenario.contractAddress,
        scenario.ownerCoinPublicKey,
        closed.context.currentQueryContext.state,
      ),
      scenario.terms,
      POSITION_SALT,
      OWNER_CLOSE_SECRET,
      scenario.ownerTarget,
    ),
    /POSITION_NOT_OPEN/,
  );
});

test('forged ownPublicKey cannot replace the ownerCloseSecret', () => {
  const scenario = openScenario();
  const forgedSecret = new Uint8Array(32).fill(41);

  // A malicious prover chooses the same ownPublicKey value as the victim.
  // The contract does not authenticate using it; the committed secret is decisive.
  const attackerContext = closeContext(
    scenario.contractAddress,
    scenario.ownerCoinPublicKey,
    scenario.state,
  );
  assert.throws(
    () => scenario.contract.circuits.ownerClose(
      attackerContext,
      scenario.terms,
      POSITION_SALT,
      forgedSecret,
      scenario.ownerTarget,
    ),
    /NOT_POSITION_OWNER/,
  );
  assert.equal(ledger(scenario.state).positionActive, true);
});

test('altered position terms, wrong recipient, and wrong recipient salt are rejected', () => {
  const scenario = openScenario();
  const forgedTerms = {
    ...scenario.terms,
    notionalAtoms: scenario.terms.notionalAtoms + 1n,
  };
  const wrongRecipient = {
    ownerRecipient: { bytes: encodeCoinPublicKey(scenario.otherCoinPublicKey) },
    recipientSalt: RECIPIENT_SALT,
  };
  const wrongRecipientSalt = {
    ownerRecipient: scenario.ownerTarget.ownerRecipient,
    recipientSalt: new Uint8Array(32).fill(43),
  };

  assert.throws(
    () => scenario.contract.circuits.ownerClose(
      closeContext(scenario.contractAddress, scenario.ownerCoinPublicKey, scenario.state),
      forgedTerms,
      POSITION_SALT,
      OWNER_CLOSE_SECRET,
      scenario.ownerTarget,
    ),
    /POSITION_WITNESS_MISMATCH/,
  );
  assert.throws(
    () => scenario.contract.circuits.ownerClose(
      closeContext(scenario.contractAddress, scenario.ownerCoinPublicKey, scenario.state),
      scenario.terms,
      POSITION_SALT,
      OWNER_CLOSE_SECRET,
      wrongRecipient,
    ),
    /OWNER_RECIPIENT_MISMATCH/,
  );
  assert.throws(
    () => scenario.contract.circuits.ownerClose(
      closeContext(scenario.contractAddress, scenario.ownerCoinPublicKey, scenario.state),
      scenario.terms,
      POSITION_SALT,
      OWNER_CLOSE_SECRET,
      wrongRecipientSalt,
    ),
    /OWNER_RECIPIENT_MISMATCH/,
  );
  assert.equal(ledger(scenario.state).positionActive, true);
});

test('commitment rejects variable collateral and notional above the fixed 5x demo cap', () => {
  assert.throws(
    () => openScenario({ coinValue: LOT_ATOMS - 1n }),
    /INVALID_COLLATERAL_AMOUNT/,
  );

  assert.throws(
    () => openScenario({ terms: { ...POSITION_TERMS, notionalAtoms: 5_000_000_001n } }),
    /NOTIONAL_EXCEEDS_DEMO_LEVERAGE/,
  );
});
