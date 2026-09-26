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
const contractPath = resolve(spikeDir, 'generated/veil_intent/contract/index.js');
if (!existsSync(contractPath)) throw new Error('Run npm test to compile VeilIntent first.');
const Veil = await import(contractPath);

const DOMAIN = new Uint8Array(32).fill(7);
const BUYER_SECRET = new Uint8Array(32).fill(17);
const AGENT_SECRET = new Uint8Array(32).fill(27);
const SELLER_SECRET = new Uint8Array(32).fill(37);
const ATTACKER_SECRET = new Uint8Array(32).fill(47);
const INTENT_SALT = new Uint8Array(32).fill(57);
const BUYER_SALT = new Uint8Array(32).fill(67);
const SELLER_SALT = new Uint8Array(32).fill(77);
const NOW = 1_000n;
const EXPIRY = 2_000n;
const PUBLIC_ESCROW = 150n;
const QUOTE_QUANTITY = 50n;
const QUOTE_PRICE_TICKS = 2_000_000n;
const PRIVATE_MAX_UNIT_PRICE = 2_000_000n;
const PRIVATE_MAX_TOTAL = 102n;

type Terms = {
  quantity: bigint;
  maxUnitPriceTicks: bigint;
  maxTotalSpendAtoms: bigint;
  expiresAt: bigint;
  nonce: Uint8Array;
};
type BuyerTarget = { recipient: { bytes: Uint8Array }; salt: Uint8Array };
type Coin = { color: Uint8Array; nonce: Uint8Array; value: bigint };

const BASE_TERMS: Terms = {
  quantity: QUOTE_QUANTITY,
  maxUnitPriceTicks: PRIVATE_MAX_UNIT_PRICE,
  maxTotalSpendAtoms: PRIVATE_MAX_TOTAL,
  expiresAt: EXPIRY,
  nonce: new Uint8Array(32).fill(87),
};

function contractWithWitnesses(
  division?: (numerator: bigint, denominator: bigint) => { quotient: bigint; remainder: bigint },
) {
  return new Veil.Contract({
    quotientRemainder(context: { privateState: unknown }, numerator: bigint, denominator: bigint) {
      return [context.privateState, division?.(numerator, denominator) ?? { quotient: numerator / denominator, remainder: numerator % denominator }];
    },
  });
}

function context(address: ReturnType<typeof sampleContractAddress>, state: unknown, caller: unknown, zswap = {}, now = NOW) {
  return createCircuitContext(address, caller as never, state as never, zswap, undefined, undefined, Number(now));
}

function stateOf(result: { context: { currentQueryContext: { state: unknown } } }) {
  return result.context.currentQueryContext.state;
}

function ledger(state: unknown) {
  return Veil.ledger((state as { data?: unknown }).data ?? state);
}

function outputs(result: { context: { currentZswapLocalState: unknown } }) {
  return decodeZswapLocalState(result.context.currentZswapLocalState as never).outputs;
}

function receiverAmount(result: { context: { currentZswapLocalState: unknown } }, recipient: Uint8Array): bigint {
  const recipientHex = Buffer.from(recipient).toString('hex');
  return outputs(result).reduce((total, output) => {
    if (!output.recipient.is_left) return total;
    return Buffer.from(encodeCoinPublicKey(output.recipient.left)).toString('hex') === recipientHex
      ? total + output.coinInfo.value
      : total;
  }, 0n);
}

function zswapInput(coin: Coin, caller: ReturnType<typeof sampleCoinPublicKey>, address: ReturnType<typeof sampleContractAddress>) {
  return encodeZswapLocalState({
    coinPublicKey: caller,
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

function createFixture(options: {
  terms?: Terms;
  division?: (numerator: bigint, denominator: bigint) => { quotient: bigint; remainder: bigint };
} = {}) {
  const contract = contractWithWitnesses(options.division);
  const buyer = sampleCoinPublicKey();
  const seller = sampleCoinPublicKey();
  const outsider = sampleCoinPublicKey();
  const solver = sampleCoinPublicKey();
  const address = sampleContractAddress();
  const terms = options.terms ?? BASE_TERMS;
  const buyerTarget: BuyerTarget = { recipient: { bytes: encodeCoinPublicKey(buyer) }, salt: BUYER_SALT };
  const sellerTarget: BuyerTarget = { recipient: { bytes: encodeCoinPublicKey(seller) }, salt: SELLER_SALT };
  const agentIdentity = Veil.pureCircuits.deriveAgentIdentityCommitment(DOMAIN, encodeContractAddress(address), AGENT_SECRET);
  const sellerIdentity = Veil.pureCircuits.deriveSellerIdentityCommitment(DOMAIN, encodeContractAddress(address), SELLER_SECRET);
  const initial = contract.initialState(createConstructorContext({}, buyer), DOMAIN);
  const minted = contract.circuits.mintTestCoin(context(address, initial.currentContractState, buyer), PUBLIC_ESCROW,
    new Uint8Array(32).fill(97)).result as Coin;
  const approvedSeller = { bytes: encodeCoinPublicKey(seller) };
  const created = contract.circuits.createIntent(
    context(address, initial.currentContractState, buyer, zswapInput(minted, buyer, address)),
    minted,
    terms,
    INTENT_SALT,
    BUYER_SECRET,
    agentIdentity,
    sellerIdentity,
    approvedSeller,
    SELLER_SALT,
    buyerTarget,
  );
  const quote = { seller: { bytes: encodeCoinPublicKey(seller) }, quantity: terms.quantity, unitPriceTicks: QUOTE_PRICE_TICKS };
  return { contract, buyer, seller, outsider, solver, address, terms, buyerTarget, sellerTarget, approvedSeller, agentIdentity, sellerIdentity, state: stateOf(created), minted, quote };
}

function submitQuote(f: ReturnType<typeof createFixture>, state: unknown, quote = f.quote, sellerSecret = SELLER_SECRET, sellerTarget = f.sellerTarget, now = NOW) {
  return f.contract.circuits.submitQuote(
    context(f.address, state, f.seller, {}, now), quote, sellerSecret, sellerTarget,
  );
}

function approveQuote(f: ReturnType<typeof createFixture>, state: unknown, terms = f.terms, agentSecret = AGENT_SECRET, now = NOW) {
  return f.contract.circuits.approveQuote(context(f.address, state, f.solver, {}, now), terms, INTENT_SALT, agentSecret);
}

function sellerClaim(f: ReturnType<typeof createFixture>, state: unknown, secret = SELLER_SECRET, target = f.sellerTarget, now = NOW) {
  return f.contract.circuits.sellerClaimPayout(context(f.address, state, f.seller, {}, now), secret, target);
}

function buyerRefund(f: ReturnType<typeof createFixture>, state: unknown, secret = BUYER_SECRET, target = f.buyerTarget) {
  return f.contract.circuits.claimBuyerRemainder(context(f.address, state, f.buyer), secret, target);
}

function cancel(f: ReturnType<typeof createFixture>, state: unknown, terms = f.terms, secret = BUYER_SECRET, target = f.buyerTarget, now = NOW) {
  return f.contract.circuits.cancelIntent(context(f.address, state, f.buyer, {}, now), terms, INTENT_SALT, secret, target);
}

test('one-to-one intent pays an authenticated seller, then lets the buyer claim committed change', () => {
  const f = createFixture();
  const escrow = ledger(f.state);
  assert.equal(escrow.intentOpen, true);
  assert.equal(escrow.buyerEscrowCoin.value, PUBLIC_ESCROW);
  assert.equal(escrow.intentDeadline, EXPIRY);
  for (const hiddenField of [
    'maxTotalSpendAtoms', 'maxUnitPriceTicks', 'intentNonce', 'intentSalt', 'buyerSecret',
    'agentSecret', 'sellerSecret', 'policyTerms',
  ]) assert.equal(hiddenField in escrow, false, `${hiddenField} must not be a public ledger field.`);

  const quoted = submitQuote(f, f.state);
  const quoteState = ledger(stateOf(quoted));
  assert.equal(quoteState.quoteSubmitted, true);
  assert.equal(quoteState.publicQuoteQuantity, QUOTE_QUANTITY);
  assert.equal(quoteState.publicQuoteUnitPriceTicks, QUOTE_PRICE_TICKS);
  assert.equal(quoteState.publicQuoteTotalAtoms, 100n);
  assert.equal(quoteState.buyerEscrowCoin.value, PUBLIC_ESCROW, 'Quote submission does not pay or move the buyer coin.');

  const approved = approveQuote(f, stateOf(quoted));
  assert.equal(ledger(stateOf(approved)).quoteApproved, true);
  assert.equal(receiverAmount(approved, encodeCoinPublicKey(f.seller)), 0n, 'Agent approval is state-only.');

  const paid = sellerClaim(f, stateOf(approved));
  const afterSellerClaim = ledger(stateOf(paid));
  assert.equal(receiverAmount(paid, encodeCoinPublicKey(f.seller)), 100n);
  assert.equal(afterSellerClaim.intentExecuted, true);
  assert.equal(afterSellerClaim.buyerRemainderClaimable, true);
  assert.equal(afterSellerClaim.buyerRemainderCoin.value, 50n);

  const buyerChange = buyerRefund(f, stateOf(paid));
  assert.equal(receiverAmount(buyerChange, encodeCoinPublicKey(f.buyer)), 50n);
  assert.equal(ledger(stateOf(buyerChange)).buyerRemainderClaimable, false);
  assert.throws(() => buyerRefund(f, stateOf(buyerChange)), /NO_BUYER_REMAINDER/);
  assert.throws(() => sellerClaim(f, stateOf(buyerChange)), /INTENT_NOT_OPEN/);
});

test('seller may claim after a valid pre-expiry agent approval without expiry stranding escrow', () => {
  const f = createFixture();
  const quoted = submitQuote(f, f.state, f.quote, SELLER_SECRET, f.sellerTarget, EXPIRY - 1n);
  const approved = approveQuote(f, stateOf(quoted), f.terms, AGENT_SECRET, EXPIRY - 1n);
  const paid = sellerClaim(f, stateOf(approved), SELLER_SECRET, f.sellerTarget, EXPIRY + 50n);
  assert.equal(receiverAmount(paid, encodeCoinPublicKey(f.seller)), 100n);
});

test('seller quote fails when unit price exceeds private max, even if total fits budget', () => {
  const f = createFixture();
  const highUnit = { ...f.quote, unitPriceTicks: PRIVATE_MAX_UNIT_PRICE + 1n };
  const quoted = submitQuote(f, f.state, highUnit);
  assert.equal(ledger(stateOf(quoted)).publicQuoteTotalAtoms, 101n);
  assert.throws(() => approveQuote(f, stateOf(quoted)), /QUOTE_PRICE_EXCEEDS_MAX/);
  assert.throws(() => submitQuote(f, stateOf(quoted), f.quote), /QUOTE_ALREADY_SUBMITTED/);
  const cancelled = cancel(f, stateOf(quoted));
  assert.equal(receiverAmount(cancelled, encodeCoinPublicKey(f.buyer)), PUBLIC_ESCROW);
});

test('agent rejects a quote whose computed total exceeds the private budget', () => {
  const terms = { ...BASE_TERMS, maxUnitPriceTicks: 2_100_000n, maxTotalSpendAtoms: 102n, quantity: 52n };
  const f = createFixture({ terms });
  const quote = { ...f.quote, quantity: 52n, unitPriceTicks: 2_000_000n };
  const quoted = submitQuote(f, f.state, quote);
  assert.equal(ledger(stateOf(quoted)).publicQuoteTotalAtoms, 104n);
  assert.throws(() => approveQuote(f, stateOf(quoted)), /QUOTE_EXCEEDS_PRIVATE_BUDGET/);
});

test('agent rejects a public quote quantity different from the private intent', () => {
  const f = createFixture();
  const quote = { ...f.quote, quantity: f.terms.quantity + 1n };
  const quoted = submitQuote(f, f.state, quote);
  assert.equal(ledger(stateOf(quoted)).publicQuoteTotalAtoms, 102n);
  assert.throws(() => approveQuote(f, stateOf(quoted)), /QUOTE_QUANTITY_MISMATCH/);
});

test('malicious quotient/remainder witnesses cannot forge the quote total', () => {
  const f = createFixture({ division: () => ({ quotient: 0n, remainder: 0n }) });
  assert.throws(() => submitQuote(f, f.state), /INVALID_DIVISION_WITNESS/);
});

test('seller identity, seller recipient, and agent authorization are independently checked', () => {
  const f = createFixture();
  const wrongSellerQuote = { ...f.quote, seller: { bytes: encodeCoinPublicKey(f.outsider) } };
  const wrongSellerTarget = { recipient: { bytes: encodeCoinPublicKey(f.outsider) }, salt: SELLER_SALT };
  assert.throws(() => submitQuote(f, f.state, wrongSellerQuote, SELLER_SECRET, wrongSellerTarget), /SELLER_NOT_APPROVED/);
  assert.throws(() => submitQuote(f, f.state, f.quote, ATTACKER_SECRET), /UNAUTHORIZED_SELLER/);
  const quoted = submitQuote(f, f.state);
  assert.throws(() => approveQuote(f, stateOf(quoted), f.terms, ATTACKER_SECRET), /UNAUTHORIZED_AGENT/);
  const approved = approveQuote(f, stateOf(quoted));
  const wrongRecipient = { recipient: { bytes: encodeCoinPublicKey(f.outsider) }, salt: SELLER_SALT };
  assert.throws(() => sellerClaim(f, stateOf(approved), SELLER_SECRET, wrongRecipient), /SELLER_RECIPIENT_MISMATCH/);
});

test('altered private policy or nonce cannot approve a committed intent', () => {
  const f = createFixture();
  const quoted = submitQuote(f, f.state);
  const changedBudget = { ...f.terms, maxTotalSpendAtoms: 103n };
  assert.throws(() => approveQuote(f, stateOf(quoted), changedBudget), /INTENT_COMMITMENT_MISMATCH/);
  const changedNonce = { ...f.terms, nonce: new Uint8Array(32).fill(99) };
  assert.throws(() => approveQuote(f, stateOf(quoted), changedNonce), /INTENT_COMMITMENT_MISMATCH/);
});

test('expired quote cannot be submitted or approved; buyer can cancel and recover the public lot', () => {
  const f = createFixture();
  assert.throws(() => submitQuote(f, f.state, f.quote, SELLER_SECRET, f.sellerTarget, EXPIRY), /INTENT_EXPIRED/);
  const quoted = submitQuote(f, f.state);
  assert.throws(() => approveQuote(f, stateOf(quoted), f.terms, AGENT_SECRET, EXPIRY), /INTENT_EXPIRED/);
  const refunded = cancel(f, stateOf(quoted), f.terms, BUYER_SECRET, f.buyerTarget, EXPIRY + 1n);
  assert.equal(receiverAmount(refunded, encodeCoinPublicKey(f.buyer)), PUBLIC_ESCROW);
  assert.equal(ledger(stateOf(refunded)).intentCancelled, true);
  assert.throws(() => submitQuote(f, stateOf(refunded)), /INTENT_NOT_OPEN/);
});

test('buyer cancellation needs buyer capability and committed recipient, and cannot revoke an approved quote', () => {
  const f = createFixture();
  assert.throws(() => cancel(f, f.state, f.terms, ATTACKER_SECRET), /NOT_INTENT_BUYER/);
  const wrongTarget = { recipient: { bytes: encodeCoinPublicKey(f.outsider) }, salt: BUYER_SALT };
  assert.throws(() => cancel(f, f.state, f.terms, BUYER_SECRET, wrongTarget), /BUYER_RECIPIENT_MISMATCH/);
  const quoted = submitQuote(f, f.state);
  const approved = approveQuote(f, stateOf(quoted));
  assert.throws(() => cancel(f, stateOf(approved)), /APPROVED_QUOTE_CANNOT_BE_CANCELLED/);
});

test('buyer remainder claim rejects a substituted recipient after seller payment', () => {
  const f = createFixture();
  const quoted = submitQuote(f, f.state);
  const approved = approveQuote(f, stateOf(quoted));
  const paid = sellerClaim(f, stateOf(approved));
  const wrongTarget = { recipient: { bytes: encodeCoinPublicKey(f.outsider) }, salt: BUYER_SALT };
  assert.throws(() => buyerRefund(f, stateOf(paid), BUYER_SECRET, wrongTarget), /BUYER_RECIPIENT_MISMATCH/);
  const validRefund = buyerRefund(f, stateOf(paid));
  assert.equal(receiverAmount(validRefund, encodeCoinPublicKey(f.buyer)), 50n);
  assert.throws(() => buyerRefund(f, stateOf(validRefund)), /NO_BUYER_REMAINDER/);
});

test('replay and a second seller quote are rejected by intent state', () => {
  const f = createFixture();
  const quoted = submitQuote(f, f.state);
  assert.throws(() => submitQuote(f, stateOf(quoted)), /QUOTE_ALREADY_SUBMITTED/);
  const approved = approveQuote(f, stateOf(quoted));
  const paid = sellerClaim(f, stateOf(approved));
  assert.throws(() => approveQuote(f, stateOf(paid)), /INTENT_NOT_OPEN/);
  assert.throws(() => sellerClaim(f, stateOf(paid)), /INTENT_NOT_OPEN/);
});
