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

const spikeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = resolve(spikeDir, 'generated/fair_launch/contract/index.js');
if (!existsSync(contractPath)) throw new Error('Run npm run compile before the Fair Launch tests.');
const Fair = await import(contractPath);

const DOMAIN = new Uint8Array(32).fill(7);
const AUTHORITY_SECRET = new Uint8Array(32).fill(17);
const RESERVE = 8n;
const DEPOSIT = 5_000n;
const COMMIT_DEADLINE = 1_100n;
const OPEN_DEADLINE = 1_200n;
const SALE_INVENTORY = 600n;
const BEFORE_COMMIT_DEADLINE = 1_000n;
const AFTER_COMMIT_DEADLINE = 1_101n;

type Amount = bigint;
type Key = ReturnType<typeof sampleCoinPublicKey>;
type Recipient = { bytes: Uint8Array };
type Opening = {
  maxPrice: Amount;
  quantity: Amount;
  refundRecipient: Recipient;
  tokenRecipient: Recipient;
  salt: Uint8Array;
};
type Coin = { color: Uint8Array; nonce: Uint8Array; value: bigint };
type Result = { context: { currentQueryContext: { state: unknown }; currentZswapLocalState: unknown } };

function makeContract() {
  return new Fair.Contract({
    quotientRemainder(context: { privateState: unknown }, numerator: bigint, denominator: bigint) {
      return [context.privateState, { quotient: numerator / denominator, remainder: numerator % denominator }];
    },
  });
}

function context(
  address: ReturnType<typeof sampleContractAddress>,
  state: unknown,
  caller: Key,
  zswap = {},
  now = BEFORE_COMMIT_DEADLINE,
) {
  return createCircuitContext(address, caller as never, state as never, zswap, undefined, undefined, Number(now));
}

function stateOf(result: Result) {
  return result.context.currentQueryContext.state;
}

function ledger(state: unknown) {
  return Fair.ledger((state as { data?: unknown }).data ?? state);
}

function outputs(result: Result) {
  return decodeZswapLocalState(result.context.currentZswapLocalState as never).outputs;
}

function receiverAmount(result: Result, recipient: Key): bigint {
  const recipientHex = Buffer.from(encodeCoinPublicKey(recipient)).toString('hex');
  return outputs(result).reduce((total, output) => {
    if (!output.recipient.is_left) return total;
    return Buffer.from(encodeCoinPublicKey(output.recipient.left)).toString('hex') === recipientHex
      ? total + output.coinInfo.value
      : total;
  }, 0n);
}

function zswapInput(
  coin: Coin,
  caller: Key,
  address: ReturnType<typeof sampleContractAddress>,
) {
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

function keyFor(_slot: number): Key {
  return sampleCoinPublicKey();
}

const walletByRecipient = new Map<string, Key>();

function recipientFor(wallet: Key): Recipient {
  const bytes = encodeCoinPublicKey(wallet);
  walletByRecipient.set(Buffer.from(bytes).toString('hex'), wallet);
  return { bytes };
}

function walletFor(recipient: Recipient): Key {
  const wallet = walletByRecipient.get(Buffer.from(recipient.bytes).toString('hex'));
  assert.ok(wallet, 'fixture recipient must map to its controlled wallet');
  return wallet;
}

function openingFor(slot: number, maxPrice: bigint, quantity: bigint): Opening {
  const recipient = keyFor(slot);
  return {
    maxPrice,
    quantity,
    refundRecipient: recipientFor(recipient),
    tokenRecipient: recipientFor(recipient),
    salt: new Uint8Array(32).fill(40 + slot),
  };
}

function referenceResult(openings: Opening[], inventory: bigint, reserve: bigint, deposit: bigint) {
  const candidatePrices = openings.map((opening) => opening.maxPrice).filter((price) => price >= reserve);
  const clearingPrice = candidatePrices
    .filter((price) => openings.reduce((total, opening) => total + (opening.maxPrice >= price ? opening.quantity : 0n), 0n) >= inventory)
    .reduce((current, price) => price > current ? price : current, reserve);
  const demandAtPrice = openings.reduce((total, opening) => total + (opening.maxPrice >= clearingPrice ? opening.quantity : 0n), 0n);
  const higherDemand = openings.reduce((total, opening) => total + (opening.maxPrice > clearingPrice ? opening.quantity : 0n), 0n);
  const oversubscribed = demandAtPrice >= inventory;
  const remaining = inventory - higherDemand;
  const marginalDemand = demandAtPrice - higherDemand;
  const allocations = openings.map((opening) => {
    if (opening.maxPrice > clearingPrice) return opening.quantity;
    if (opening.maxPrice < clearingPrice) return 0n;
    if (!oversubscribed) return opening.quantity;
    assert.equal((opening.quantity * remaining) % marginalDemand, 0n, 'fixture has integral marginal shares');
    return opening.quantity * remaining / marginalDemand;
  });
  const refunds = openings.map((_, slot) => deposit - clearingPrice * allocations[slot]!);
  return { oversubscribed, clearingPrice, allocations, refunds };
}

function createFixture(
  openings: Opening[],
  options: { inventory?: bigint; reserve?: bigint; deposit?: bigint; commitDeadline?: bigint; openDeadline?: bigint } = {},
) {
  const contract = makeContract();
  const address = sampleContractAddress();
  const seller = keyFor(8);
  const bidders = openings.map((opening) => walletFor(opening.refundRecipient));
  const inventory = options.inventory ?? SALE_INVENTORY;
  const reserve = options.reserve ?? RESERVE;
  const deposit = options.deposit ?? DEPOSIT;
  const commitDeadline = options.commitDeadline ?? COMMIT_DEADLINE;
  const openDeadline = options.openDeadline ?? OPEN_DEADLINE;
  const paymentDomain = Fair.pureCircuits.paymentTestTokenDomain();
  const saleDomain = Fair.pureCircuits.saleTestTokenDomain();
  const authorityCommitment = Fair.pureCircuits.deriveInventoryAuthorityCommitment(DOMAIN, AUTHORITY_SECRET);
  const initial = contract.initialState(
    createConstructorContext({}, seller),
    DOMAIN,
    inventory,
    reserve,
    deposit,
    commitDeadline,
    openDeadline,
    paymentDomain,
    saleDomain,
    authorityCommitment,
    recipientFor(seller),
  );
  const saleMinted = contract.circuits.mintTestSaleCoin(
    context(address, initial.currentContractState, seller),
    inventory,
    new Uint8Array(32).fill(91),
    AUTHORITY_SECRET,
  );
  const saleCoin = saleMinted.result as Coin;
  const funded = contract.circuits.fundSaleInventory(
    context(address, stateOf(saleMinted), seller, zswapInput(saleCoin, seller, address)),
    saleCoin,
    AUTHORITY_SECRET,
  );
  let state = stateOf(funded);
  const paymentCoins: Coin[] = [];
  for (let slot = 0; slot < openings.length; slot += 1) {
    const bidder = bidders[slot]!;
    const paymentCoin = contract.circuits.mintTestPaymentCoin(
      context(address, state, bidder),
      deposit,
      new Uint8Array(32).fill(101 + slot),
    ).result as Coin;
    paymentCoins.push(paymentCoin);
    const registered = contract.circuits.registerBid(
      context(address, state, bidder, zswapInput(paymentCoin, bidder, address)),
      BigInt(slot),
      openings[slot],
      paymentCoin,
    );
    state = stateOf(registered);
  }
  return { contract, address, seller, bidders, openings, paymentCoins, state, inventory, reserve, deposit, commitDeadline, openDeadline };
}

function settle(f: ReturnType<typeof createFixture>, result: ReturnType<typeof referenceResult>, openings = f.openings, now = AFTER_COMMIT_DEADLINE) {
  const padded = [...openings];
  while (padded.length < 4) padded.push(openingFor(padded.length, 0n, 0n));
  return f.contract.circuits.settle(
    context(f.address, f.state, f.seller, {}, now),
    result.oversubscribed,
    result.clearingPrice,
    result.allocations[0] ?? 0n,
    result.allocations[1] ?? 0n,
    result.allocations[2] ?? 0n,
    result.allocations[3] ?? 0n,
    padded[0], padded[1], padded[2], padded[3],
  );
}

test('four registered private openings settle at one price and independently claim refunds, proceeds, and tokens', () => {
  const openings = [
    openingFor(0, 12n, 300n),
    openingFor(1, 10n, 500n),
    openingFor(2, 8n, 400n),
    openingFor(3, 8n, 200n),
  ];
  const f = createFixture(openings);
  const result = referenceResult(openings, f.inventory, f.reserve, f.deposit);
  assert.deepEqual(result, {
    oversubscribed: true,
    clearingPrice: 10n,
    allocations: [300n, 300n, 0n, 0n],
    refunds: [2_000n, 2_000n, 5_000n, 5_000n],
  });

  const settled = settle(f, result);
  const settledState = stateOf(settled);
  const publicState = ledger(settledState);
  assert.equal(publicState.clearingPrice, 10n);
  assert.deepEqual([publicState.allocated0, publicState.allocated1, publicState.allocated2, publicState.allocated3], result.allocations);
  assert.deepEqual([publicState.refund0, publicState.refund1, publicState.refund2, publicState.refund3], result.refunds);
  for (const hidden of ['maxPrice', 'quantity', 'salt', 'refundRecipient', 'tokenRecipient']) {
    assert.equal(hidden in publicState, false, `${hidden} must remain out of the public ledger`);
  }
  assert.equal(publicState.registeredBidCount, 4n);
  assert.equal(
    f.deposit * publicState.registeredBidCount,
    result.refunds.reduce((sum, refund) => sum + refund, 0n) + result.allocations.reduce((sum, quantity) => sum + quantity * result.clearingPrice, 0n),
  );

  const badOpening = { ...openings[3], salt: new Uint8Array(32).fill(99) };
  assert.throws(() => settle(f, result, [openings[0]!, openings[1]!, openings[2]!, badOpening]), /SLOT3_OPENING_MISMATCH/);
  assert.throws(() => settle(f, { ...result, clearingPrice: 9n }), /CLEARING_PRICE_TOO_LOW/);
  assert.throws(() => settle(f, { ...result, allocations: [300n, 299n, 1n, 0n] }), /SLOT1_ALLOCATION_MISMATCH/);
  assert.throws(() => f.contract.circuits.mintTestSaleCoin(
    context(f.address, settledState, f.seller),
    f.inventory,
    new Uint8Array(32).fill(92),
    AUTHORITY_SECRET,
  ), /SALE_INVENTORY_ALREADY_MINTED/);

  let state = settledState;
  for (const slot of [2, 3]) {
    const bidder = f.bidders[slot]!;
    const claimed = f.contract.circuits.claimTokens(context(f.address, state, bidder), BigInt(slot), openings[slot]!);
    state = stateOf(claimed);
    assert.equal(receiverAmount(claimed, bidder), 0n);
  }
  for (const slot of [0, 1]) {
    const bidder = f.bidders[slot]!;
    const refund = f.contract.circuits.claimRefund(context(f.address, state, bidder), BigInt(slot), openings[slot]!);
    state = stateOf(refund);
    assert.equal(receiverAmount(refund, bidder), result.refunds[slot]);
    assert.equal(ledger(state)[`proceedsAvailable${slot}`], true);
    const proceeds = f.contract.circuits.claimProceeds(context(f.address, state, f.seller), BigInt(slot));
    state = stateOf(proceeds);
    assert.equal(receiverAmount(proceeds, f.seller), 3_000n);
    assert.equal(ledger(state)[`proceedsAvailable${slot}`], false);
    assert.throws(() => f.contract.circuits.claimProceeds(context(f.address, state, f.seller), BigInt(slot)), /NO_PROCEEDS_FOR_SLOT/);
  }
  for (const slot of [0, 1]) {
    const bidder = f.bidders[slot]!;
    const claimed = f.contract.circuits.claimTokens(context(f.address, state, bidder), BigInt(slot), openings[slot]!);
    state = stateOf(claimed);
    assert.equal(receiverAmount(claimed, bidder), result.allocations[slot]);
    if (slot == 0) {
      assert.throws(() => f.contract.circuits.claimTokens(context(f.address, state, bidder), BigInt(slot), openings[slot]!), /TOKENS_ALREADY_CLAIMED/);
    }
  }
  assert.equal(ledger(state).inventoryRemainderAvailable, false);
  assert.throws(() => f.contract.circuits.claimRefund(context(f.address, state, f.bidders[0]!), 0n, openings[0]!), /REFUND_ALREADY_CLAIMED/);
  assert.throws(() => f.contract.circuits.claimProceeds(context(f.address, state, f.seller), 0n), /NO_PROCEEDS_FOR_SLOT/);
});

test('one to four registered bid counts conserve deposits, reject phantom slots, and allocate undersubscribed demand at the reserve', () => {
  for (let count = 1; count <= 4; count += 1) {
    const openings = Array.from({ length: count }, (_, slot) => openingFor(slot, 8n + BigInt(slot), 50n));
    const inventory = 600n;
    const f = createFixture(openings, { inventory });
    const result = referenceResult(openings, inventory, f.reserve, f.deposit);
    const settled = settle(f, result);
    const state = stateOf(settled);
    const publicState = ledger(state);
    assert.equal(publicState.registeredBidCount, BigInt(count));
    assert.equal(publicState.clearingPrice, f.reserve);
    assert.deepEqual(
      [publicState.refund0, publicState.refund1, publicState.refund2, publicState.refund3].slice(count),
      [0n, 0n, 0n, 0n].slice(count),
      'unused fixed slots carry no refund claim',
    );
    assert.deepEqual(result.allocations, Array.from({ length: count }, () => 50n));
    assert.equal(
      BigInt(count) * f.deposit,
      result.refunds.reduce((sum, refund) => sum + refund, 0n) + result.allocations.reduce((sum, quantity) => sum + quantity * result.clearingPrice, 0n),
    );
  }
});

test('an indivisible marginal pro-rata result is rejected instead of favoring a slot', () => {
  const openings = [
    openingFor(0, 10n, 3n),
    openingFor(1, 8n, 4n),
    openingFor(2, 8n, 4n),
    openingFor(3, 8n, 4n),
  ];
  const f = createFixture(openings, { inventory: 5n, reserve: 8n, deposit: 100n });
  const proposed = { oversubscribed: true, clearingPrice: 8n, allocations: [3n, 1n, 1n, 0n], refunds: [] };
  assert.throws(() => settle(f, proposed), /NON_INTEGRAL_MARGINAL_ALLOCATION/);
});

test('two equal-price marginal bidders split the remaining inventory without slot priority', () => {
  const openings = [openingFor(0, 8n, 400n), openingFor(1, 8n, 400n)];
  const f = createFixture(openings, { inventory: 600n });
  const result = referenceResult(openings, 600n, f.reserve, f.deposit);
  assert.equal(result.clearingPrice, 8n);
  assert.deepEqual(result.allocations, [300n, 300n]);
  const settled = settle(f, result);
  assert.deepEqual([ledger(stateOf(settled)).allocated0, ledger(stateOf(settled)).allocated1], [300n, 300n]);
});

test('opening timeout cancels the whole auction and registered bidders can claim the full public lot', () => {
  const openings = [openingFor(0, 12n, 100n), openingFor(1, 10n, 100n)];
  const f = createFixture(openings, { openDeadline: 1_300n });
  const cancelled = f.contract.circuits.cancelAfterOpeningDeadline(context(f.address, f.state, f.seller, {}, 1_300n));
  let state = stateOf(cancelled);
  assert.equal(ledger(state).cancelled, true);
  assert.deepEqual([ledger(state).refund0, ledger(state).refund1, ledger(state).refund2, ledger(state).refund3], [f.deposit, f.deposit, 0n, 0n]);
  for (let slot = 0; slot < openings.length; slot += 1) {
    const bidder = f.bidders[slot]!;
    const refunded = f.contract.circuits.claimRefund(context(f.address, state, bidder, {}, 1_301n), BigInt(slot), openings[slot]!);
    state = stateOf(refunded);
    assert.equal(receiverAmount(refunded, bidder), f.deposit);
  }
  assert.throws(() => f.contract.circuits.claimProceeds(context(f.address, state, f.seller), 0n), /AUCTION_NOT_SETTLED/);
  const recovered = f.contract.circuits.claimUnsoldInventory(context(f.address, state, f.seller, {}, 1_301n), AUTHORITY_SECRET);
  assert.equal(receiverAmount(recovered, f.seller), SALE_INVENTORY);
});
