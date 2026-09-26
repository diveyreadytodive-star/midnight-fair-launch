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
const contractPath = resolve(spikeDir, 'generated/lp_reserve/contract/index.js');
if (!existsSync(contractPath)) throw new Error('Compile the LP reserve spike first.');
const LpReserve = await import(contractPath);

const COLLATERAL = 1000n;
const RESERVE = 500n;
const NETWORK_DOMAIN = new Uint8Array(32).fill(41);
const OWNER_SECRET = new Uint8Array(32).fill(43);
const LP_SECRET = new Uint8Array(32).fill(45);
const OWNER_SALT = new Uint8Array(32).fill(47);
const LP_SALT = new Uint8Array(32).fill(53);

function makeZswapInput(coin: { color: Uint8Array; nonce: Uint8Array; value: bigint }, caller: unknown, address: unknown) {
  return encodeZswapLocalState({
    coinPublicKey: caller as never,
    currentIndex: 88n,
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

function createBase() {
  const ownerKey = sampleCoinPublicKey();
  const lpKey = sampleCoinPublicKey();
  const attackerKey = sampleCoinPublicKey();
  const contractAddress = sampleContractAddress();
  const contract = new LpReserve.Contract({});
  const constructor = contract.initialState(
    createConstructorContext({}, ownerKey),
    NETWORK_DOMAIN,
  );
  const state = constructor.currentContractState;
  const ownerRecipient = {
    recipient: { bytes: encodeCoinPublicKey(ownerKey) },
    salt: OWNER_SALT,
  };
  const lpRecipient = {
    recipient: { bytes: encodeCoinPublicKey(lpKey) },
    salt: LP_SALT,
  };
  return { contract, contractAddress, ownerKey, lpKey, attackerKey, state, ownerRecipient, lpRecipient };
}

function mintCoin(
  fixture: ReturnType<typeof createBase>,
  state: unknown,
  caller: unknown,
  amount: bigint,
  nonceSeed: number,
) {
  return fixture.contract.circuits.mintTestCoin(
    createCircuitContext(fixture.contractAddress, caller as never, state as never, {}),
    amount,
    new Uint8Array(32).fill(nonceSeed),
  ).result;
}

function fundReserve(fixture: ReturnType<typeof createBase>, state = fixture.state, coin?: { color: Uint8Array; nonce: Uint8Array; value: bigint }) {
  const reserve = coin ?? mintCoin(fixture, state, fixture.lpKey, RESERVE, 59);
  return fixture.contract.circuits.fundReserve(
    createCircuitContext(
      fixture.contractAddress,
      makeZswapInput(reserve, fixture.lpKey, fixture.contractAddress) as never,
      state as never,
      {},
    ),
    reserve,
    LP_SECRET,
    fixture.lpRecipient,
  );
}

function openPosition(fixture: ReturnType<typeof createBase>, state: unknown, coin?: { color: Uint8Array; nonce: Uint8Array; value: bigint }) {
  const trader = coin ?? mintCoin(fixture, state, fixture.ownerKey, COLLATERAL, 61);
  return fixture.contract.circuits.openPosition(
    createCircuitContext(
      fixture.contractAddress,
      makeZswapInput(trader, fixture.ownerKey, fixture.contractAddress) as never,
      state as never,
      {},
    ),
    trader,
    OWNER_SECRET,
    fixture.ownerRecipient,
  );
}

function claim(fixture: ReturnType<typeof createBase>, state: unknown, payout: bigint) {
  return fixture.contract.circuits.claim(
    createCircuitContext(fixture.contractAddress, fixture.ownerKey, state as never, {}),
    payout,
    OWNER_SECRET,
    fixture.ownerRecipient,
  );
}

function claimLpLoss(
  fixture: ReturnType<typeof createBase>,
  state: unknown,
  caller = fixture.lpKey,
  lpSecret = LP_SECRET,
  recipient = fixture.lpRecipient,
) {
  return fixture.contract.circuits.claimLpLoss(
    createCircuitContext(fixture.contractAddress, caller as never, state as never, {}),
    lpSecret,
    recipient,
  );
}

function withdrawReserveRemainder(fixture: ReturnType<typeof createBase>, state: unknown) {
  return fixture.contract.circuits.withdrawReserveRemainder(
    createCircuitContext(fixture.contractAddress, fixture.lpKey, state as never, {}),
    LP_SECRET,
    fixture.lpRecipient,
  );
}

function fundedPosition() {
  const fixture = createBase();
  const reserveFunded = fundReserve(fixture);
  const opened = openPosition(fixture, reserveFunded.context.currentQueryContext.state);
  return { ...fixture, state: opened.context.currentQueryContext.state };
}

function outputs(result: { context: { currentZswapLocalState: unknown } }) {
  return zswapState(result).outputs;
}

function zswapState(result: { context: { currentZswapLocalState: unknown } }) {
  return decodeZswapLocalState(result.context.currentZswapLocalState as never);
}

function ledger(state: unknown) {
  return LpReserve.ledger((state as { data?: unknown }).data ?? state);
}

function outputSummary(txOutputs: ReturnType<typeof outputs>) {
  return JSON.stringify(txOutputs.map((output) => ({
    value: output.coinInfo.value.toString(),
    recipientIsKey: output.recipient.is_left,
    recipient: output.recipient.is_left
      ? Buffer.from(encodeCoinPublicKey(output.recipient.left)).toString('hex')
      : 'contract',
  })));
}

test('opening is blocked until a real fixed 500-unit same-token reserve coin is locked', () => {
  const fixture = createBase();
  const trader = mintCoin(fixture, fixture.state, fixture.ownerKey, COLLATERAL, 67);
  assert.throws(() => openPosition(fixture, fixture.state, trader), /LP_RESERVE_NOT_FUNDED/);

  const funded = fundReserve(fixture);
  assert.equal(ledger(funded.context.currentQueryContext.state).reserveFunded, true);
  assert.equal(ledger(funded.context.currentQueryContext.state).reserveCoin.value, RESERVE);
});

test('reserve rejects wrong token and non-exact value', () => {
  const fixture = createBase();
  const wrongToken = mintCoin(fixture, fixture.state, fixture.lpKey, RESERVE, 71);
  assert.throws(
    () => fundReserve(fixture, fixture.state, { ...wrongToken, color: new Uint8Array(32).fill(72) }),
    /INVALID_RESERVE_TOKEN/,
  );

  const wrongAmount = mintCoin(fixture, fixture.state, fixture.lpKey, RESERVE + 1n, 73);
  assert.throws(() => fundReserve(fixture, fixture.state, wrongAmount), /INVALID_RESERVE_AMOUNT/);
});

test('position rejects a trader coin with a different token color', () => {
  const fixture = createBase();
  const funded = fundReserve(fixture);
  const trader = mintCoin(fixture, funded.context.currentQueryContext.state, fixture.ownerKey, COLLATERAL, 79);
  assert.throws(
    () => openPosition(fixture, funded.context.currentQueryContext.state, { ...trader, color: new Uint8Array(32).fill(80) }),
    /INVALID_TRADER_TOKEN/,
  );
});

test('payout above combined funded coins is rejected without settling', () => {
  const fixture = fundedPosition();
  assert.throws(() => claim(fixture, fixture.state, 1501n), /PAYOUT_EXCEEDS_FUNDED_ASSETS/);
  const state = ledger(fixture.state);
  assert.equal(state.positionActive, true);
  assert.equal(state.settled, false);
});

test('a zero payout retains the full loss coin until the LP claims from its own wallet', () => {
  const fixture = fundedPosition();
  const traderSettled = claim(fixture, fixture.state, 0n);
  const retainedOutputs = outputs(traderSettled);
  assert.equal(retainedOutputs.length, 1, outputSummary(retainedOutputs));
  assert.equal(retainedOutputs[0]?.coinInfo.value, COLLATERAL);
  assert.equal(retainedOutputs[0]?.recipient.is_left, false);
  let state = ledger(traderSettled.context.currentQueryContext.state);
  assert.equal(state.settled, true);
  assert.equal(state.lpLossClaimable, true);
  assert.equal(state.lpLossCoin.value, COLLATERAL);

  const lpClaim = claimLpLoss(fixture, traderSettled.context.currentQueryContext.state);
  const lpOutputs = outputs(lpClaim);
  assert.equal(lpOutputs.length, 1);
  assert.equal(lpOutputs[0]?.coinInfo.value, COLLATERAL);
  assert.equal(lpOutputs[0]?.recipient.is_left, true);
  assert.deepEqual(encodeCoinPublicKey(lpOutputs[0]!.recipient.left), encodeCoinPublicKey(fixture.lpKey));
  state = ledger(lpClaim.context.currentQueryContext.state);
  assert.equal(state.lpLossClaimable, false);
});

test('a losing payout stores the trader change for a separate LP wallet claim', () => {
  const fixture = fundedPosition();
  const traderSettled = claim(fixture, fixture.state, 800n);
  const txOutputs = outputs(traderSettled);
  assert.equal(txOutputs.length, 2, outputSummary(txOutputs));
  const paidTo = (key: unknown) => txOutputs.find((output) => output.recipient.is_left &&
    encodeCoinPublicKey(output.recipient.left)!.toString() === encodeCoinPublicKey(key as never)!.toString());
  assert.equal(paidTo(fixture.ownerKey)?.coinInfo.value, 800n);
  assert.equal(txOutputs.filter((output) => !output.recipient.is_left)[0]?.coinInfo.value, COLLATERAL - 800n);
  assert.equal(zswapState(traderSettled).inputs.length, 1,
    'the LP loss coin remains unspent in contract custody through the trader transaction');
  let state = ledger(traderSettled.context.currentQueryContext.state);
  assert.equal(state.reserveCoin.value, RESERVE);
  assert.equal(state.lpLossCoin.value, COLLATERAL - 800n);
  assert.equal(state.lpLossClaimable, true);

  const lpClaim = claimLpLoss(fixture, traderSettled.context.currentQueryContext.state);
  const lpOutputs = outputs(lpClaim);
  assert.equal(lpOutputs.length, 1);
  assert.equal(lpOutputs[0]?.coinInfo.value, COLLATERAL - 800n);
  assert.equal(lpOutputs[0]?.recipient.is_left, true);
  assert.deepEqual(encodeCoinPublicKey(lpOutputs[0]!.recipient.left), encodeCoinPublicKey(fixture.lpKey));
  state = ledger(lpClaim.context.currentQueryContext.state);
  assert.equal(state.lpLossClaimable, false);
});

test('a profit payout spends the real reserve coin and preserves its committed remainder', () => {
  const fixture = fundedPosition();
  const paid = claim(fixture, fixture.state, 1200n);
  const txOutputs = outputs(paid);
  assert.equal(txOutputs.length, 3, outputSummary(txOutputs));
  assert.deepEqual(txOutputs.filter((output) => output.recipient.is_left)
    .map((output) => output.coinInfo.value).sort((a, b) => a < b ? -1 : 1), [200n, COLLATERAL]);
  assert.equal(txOutputs.find((output) => !output.recipient.is_left)?.coinInfo.value, RESERVE - 200n,
    'the reserve remainder is a new contract-owned shielded coin');

  const state = ledger(paid.context.currentQueryContext.state);
  assert.equal(state.reserveFunded, true);
  assert.equal(state.reserveCoin.value, 300n);
  assert.notDeepEqual(state.reserveCoin.nonce, ledger(fixture.state).reserveCoin.nonce);

  const laterSpend = withdrawReserveRemainder(fixture, paid.context.currentQueryContext.state);
  const laterOutputs = outputs(laterSpend);
  assert.equal(laterOutputs.length, 1);
  assert.equal(laterOutputs[0]?.coinInfo.value, 300n);
  assert.equal(laterOutputs[0]?.recipient.is_left, true);
  assert.deepEqual(encodeCoinPublicKey(laterOutputs[0]!.recipient.left), encodeCoinPublicKey(fixture.lpKey));
  assert.equal(ledger(laterSpend.context.currentQueryContext.state).reserveFunded, false);
  assert.throws(
    () => withdrawReserveRemainder(fixture, laterSpend.context.currentQueryContext.state),
    /NO_RESERVE_REMAINDER/,
  );
});

test('maximum profit consumes both coins exactly and marks the reserve empty', () => {
  const fixture = fundedPosition();
  const paid = claim(fixture, fixture.state, COLLATERAL + RESERVE);
  const state = ledger(paid.context.currentQueryContext.state);
  assert.equal(outputs(paid).reduce((sum, output) => sum + output.coinInfo.value, 0n), COLLATERAL + RESERVE);
  assert.equal(state.reserveFunded, false);
});

test('owner can settle without knowing the LP secret or recipient opening', () => {
  const fixture = fundedPosition();
  // The claim API takes only the trader's payout, owner capability, and the
  // owner recipient opening. Neither LP_SECRET nor LP_SALT is passed here.
  const paid = claim(fixture, fixture.state, 800n);
  assert.equal(ledger(paid.context.currentQueryContext.state).settled, true);
  assert.equal(ledger(paid.context.currentQueryContext.state).lpLossClaimable, true);
  assert.equal(ledger(paid.context.currentQueryContext.state).lpLossCoin.value, 200n);
});

test('an incorrect LP secret cannot claim the retained loss coin', () => {
  const fixture = fundedPosition();
  const traderSettled = claim(fixture, fixture.state, 800n);
  assert.throws(
    () => claimLpLoss(
      fixture,
      traderSettled.context.currentQueryContext.state,
      fixture.lpKey,
      new Uint8Array(32).fill(81),
    ),
    /NOT_AUTHORIZED_LP/,
  );
  assert.equal(ledger(traderSettled.context.currentQueryContext.state).lpLossClaimable, true);
});

test('an LP cannot substitute its committed recipient on claim', () => {
  const fixture = fundedPosition();
  const traderSettled = claim(fixture, fixture.state, 800n);
  const substitutedRecipient = {
    recipient: { bytes: encodeCoinPublicKey(fixture.attackerKey) },
    salt: LP_SALT,
  };
  assert.throws(
    () => claimLpLoss(fixture, traderSettled.context.currentQueryContext.state, fixture.lpKey, LP_SECRET, substitutedRecipient),
    /LP_RECIPIENT_MISMATCH/,
  );
});

test('an LP cannot replay its loss-coin claim', () => {
  const fixture = fundedPosition();
  const traderSettled = claim(fixture, fixture.state, 800n);
  const lpClaim = claimLpLoss(fixture, traderSettled.context.currentQueryContext.state);
  assert.throws(
    () => claimLpLoss(fixture, lpClaim.context.currentQueryContext.state),
    /NO_LP_LOSS_TO_CLAIM/,
  );
});

test('settlement is one-shot', () => {
  const fixture = fundedPosition();
  const paid = claim(fixture, fixture.state, 1000n);
  assert.throws(
    () => claim(fixture, paid.context.currentQueryContext.state, 1000n),
    /POSITION_NOT_OPEN/,
  );
});
