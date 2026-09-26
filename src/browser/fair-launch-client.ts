import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import { createCallTxOptions, submitCallTxAsync } from '@midnight-ntwrk/midnight-js-contracts';
import { dappConnectorProofProvider } from '@midnight-ntwrk/midnight-js-dapp-connector-proof-provider';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { encodeCoinPublicKey, encodeContractAddress, fromHex, toHex } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { Binding, CostModel, Proof, SignatureEnabled, Transaction } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type { ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type { PrivateStateProvider, UnboundTransaction } from '@midnight-ntwrk/midnight-js-types';
import * as fairLaunch from '../../spikes/fair-launch/generated/fair_launch/contract/index.js';

export type CoinRecord = { nonce: Uint8Array; color: Uint8Array; value: bigint };
type Stage = 'proving' | 'submitted' | 'confirmed';
const PREPROD_INDEXER = 'https://indexer.preprod.midnight.network/api/v4/graphql';
const PREPROD_INDEXER_WS = 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws';

export async function readPreprodAuction(address: string, expected: {
  metadataCommitmentHex: string; inventoryAtoms: string; reservePriceAtoms: string; depositLotAtoms: string;
}) {
  if (!/^[0-9a-f]{64}$/i.test(address) || !/^[0-9a-f]{64}$/i.test(expected.metadataCommitmentHex)) {
    throw new Error('Invalid Preprod auction identity');
  }
  setNetworkId('preprod');
  const provider = indexerPublicDataProvider(PREPROD_INDEXER, PREPROD_INDEXER_WS, WebSocket as never);
  const state = await provider.queryContractState(address as ContractAddress);
  if (!state) throw new Error('Preprod contract state is unavailable');
  const ledger = fairLaunch.ledger(((state as { data?: unknown }).data ?? state) as never);
  if (toHex(ledger.networkDomain) !== expected.metadataCommitmentHex ||
      ledger.saleInventory !== BigInt(expected.inventoryAtoms) ||
      ledger.reservePrice !== BigInt(expected.reservePriceAtoms) ||
      ledger.depositLot !== BigInt(expected.depositLotAtoms) || !ledger.saleInventoryFunded) {
    throw new Error('Preprod ledger does not match verified setup evidence');
  }
  const response = await fetch(PREPROD_INDEXER, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'query FairLaunchTip { block { height timestamp } }' }), signal: AbortSignal.timeout(15_000) });
  const result = await response.json() as { data?: { block?: { height?: number; timestamp?: number } }; errors?: unknown[] };
  const tip = result.data?.block;
  if (!response.ok || result.errors?.length || !Number.isSafeInteger(tip?.height) || !Number.isSafeInteger(tip?.timestamp)) {
    throw new Error('Preprod chain time is unavailable');
  }
  const chainTime = BigInt(Math.floor(tip!.timestamp! / 1000));
  const phase = ledger.cancelled ? 'cancelled' : ledger.settled ? 'settled'
    : chainTime < ledger.commitDeadline ? 'commit'
      : chainTime < ledger.openDeadline ? 'open' : 'settling';
  return {
    phase, registeredBidCount: String(ledger.registeredBidCount), settled: ledger.settled,
    cancelled: ledger.cancelled, clearingPriceAtoms: String(ledger.clearingPrice),
    settlement: ledger.settled ? {
      clearingPriceAtoms: String(ledger.clearingPrice),
      allocationsAtoms: [ledger.allocated0, ledger.allocated1, ledger.allocated2, ledger.allocated3].map(String),
      refundsAtoms: [ledger.refund0, ledger.refund1, ledger.refund2, ledger.refund3].map(String),
      tokenClaimed: [ledger.tokenClaimed0, ledger.tokenClaimed1, ledger.tokenClaimed2, ledger.tokenClaimed3],
      refundClaimed: [ledger.refundClaimed0, ledger.refundClaimed1, ledger.refundClaimed2, ledger.refundClaimed3],
    } : null,
    blockHeight: tip!.height!, chainTimeUnixSeconds: String(chainTime),
    commitDeadlineUnixSeconds: String(ledger.commitDeadline), openDeadlineUnixSeconds: String(ledger.openDeadline),
  };
}

export async function verifyBrowserZkAssets(assetBaseUrl: string, circuit: 'mintTestPaymentCoin' | 'registerBid') {
  const provider = new FetchZkConfigProvider(new URL(assetBaseUrl, location.href).href, fetch.bind(window));
  const [prover, verifier, zkir] = await Promise.all([
    provider.getProverKey(circuit), provider.getVerifierKey(circuit), provider.getZKIR(circuit),
  ]);
  if (prover.length === 0 || verifier.length === 0 || zkir.length === 0) throw new Error('Incomplete ZK artifact set');
  const hashes = await Promise.all([prover, verifier, zkir].map(async (value) =>
    toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', value as BufferSource)))));
  return { circuit, proverBytes: prover.length, verifierBytes: verifier.length, zkirBytes: zkir.length,
    proverSha256: hashes[0], verifierSha256: hashes[1], zkirSha256: hashes[2] };
}

function memoryPrivateState(): PrivateStateProvider<string, unknown> & { setContractAddress(address: ContractAddress): void } {
  const states = new Map<string, unknown>();
  const signingKeys = new Map<string, string>();
  let address = '';
  const key = (id: string) => `${address}:${id}`;
  return {
    setContractAddress(value) { address = value; },
    async get(id) { return states.get(key(id)) ?? null; },
    async set(id, value) { states.set(key(id), value); },
    async remove(id) { states.delete(key(id)); },
    async clear() { for (const id of states.keys()) if (id.startsWith(`${address}:`)) states.delete(id); },
    async getSigningKey(value) { return signingKeys.get(value) ?? null; },
    async setSigningKey(value, signingKey) { signingKeys.set(value, signingKey); },
    async removeSigningKey(value) { signingKeys.delete(value); },
    async clearSigningKeys() { signingKeys.clear(); },
    async exportPrivateStates() { throw new Error('Private-state export is unavailable in the isolated transaction probe.'); },
    async importPrivateStates() { throw new Error('Private-state import is unavailable in the isolated transaction probe.'); },
    async exportSigningKeys() { throw new Error('Signing-key export is unavailable in the isolated transaction probe.'); },
    async importSigningKeys() { throw new Error('Signing-key import is unavailable in the isolated transaction probe.'); },
  };
}

export async function createFairLaunchBrowserClient(api: ConnectedAPI, address: string, assetBaseUrl: string) {
  if (!/^[0-9a-f]{64}$/i.test(address)) throw new Error('Invalid contract address');
  const [configuration, connection, keys, dust] = await Promise.all([
    api.getConfiguration(), api.getConnectionStatus(), api.getShieldedAddresses(), api.getDustBalance(),
  ]);
  if (configuration.networkId !== 'preprod' || connection.status !== 'connected' || connection.networkId !== 'preprod') {
    throw new Error('A connected Preprod wallet is required');
  }
  const dustBalance = typeof dust === 'bigint' ? dust : dust.balance;
  if (dustBalance <= 0n) throw new Error('The wallet needs tDUST before a test transaction');
  if (!keys.shieldedCoinPublicKey || !keys.shieldedEncryptionPublicKey) throw new Error('Missing shielded public keys');
  setNetworkId('preprod');

  const zkConfigProvider = new FetchZkConfigProvider(new URL(assetBaseUrl, location.href).href, fetch.bind(window));
  const publicDataProvider = indexerPublicDataProvider(configuration.indexerUri, configuration.indexerWsUri, WebSocket as never);
  const existing = await publicDataProvider.queryContractState(address as ContractAddress);
  if (!existing) throw new Error('Contract was not found on the wallet network');
  const privateStateProvider = memoryPrivateState();
  privateStateProvider.setContractAddress(address as ContractAddress);
  const proofProvider = await dappConnectorProofProvider(api, zkConfigProvider, CostModel.initialCostModel());
  const walletProvider = {
    getCoinPublicKey: () => keys.shieldedCoinPublicKey,
    getEncryptionPublicKey: () => keys.shieldedEncryptionPublicKey,
    async balanceTx(tx: UnboundTransaction) {
      const balanced = await api.balanceUnsealedTransaction(toHex(tx.serialize()));
      return Transaction.deserialize<SignatureEnabled, Proof, Binding>('signature', 'proof', 'binding', fromHex(balanced.tx));
    },
  };
  const midnightProvider = {
    async submitTx(tx: ReturnType<typeof Transaction.deserialize<SignatureEnabled, Proof, Binding>>) {
      await api.submitTransaction(toHex(tx.serialize()));
      return tx.identifiers()[0];
    },
  };
  const providers = { privateStateProvider, publicDataProvider, zkConfigProvider, proofProvider, walletProvider, midnightProvider };
  const compiled = CompiledContract.make('fair-launch', fairLaunch.Contract).pipe(
    CompiledContract.withWitnesses({
      quotientRemainder(context: { readonly privateState: unknown }, numerator: bigint, denominator: bigint) {
        return [context.privateState, { quotient: numerator / denominator, remainder: numerator % denominator }];
      },
    }),
    CompiledContract.withCompiledFileAssets('.'),
  );

  async function confirmedCall(circuit: 'mintTestPaymentCoin' | 'registerBid', args: readonly unknown[], onStage: (stage: Stage) => void) {
    onStage('proving');
    const options = createCallTxOptions(compiled as never, circuit as never, address as ContractAddress,
      undefined, undefined, [...args] as never);
    const submitted = await submitCallTxAsync(providers as never, options as never);
    onStage('submitted');
    const result = await Promise.race([
      publicDataProvider.watchForTxData(submitted.txId),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Transaction confirmation timed out')), 300_000)),
    ]);
    if (result.status !== 'SucceedEntirely') throw new Error(`${circuit} did not succeed entirely`);
    onStage('confirmed');
    return { submitted, blockHeight: result.blockHeight };
  }

  return {
    makeOwnBidOpening(maxPrice: bigint, quantity: bigint): fairLaunch.BidOpening {
      if (maxPrice <= 0n || quantity <= 0n) throw new Error('Bid price and quantity must be positive');
      const recipient = { bytes: encodeCoinPublicKey(keys.shieldedCoinPublicKey) };
      return { maxPrice, quantity, refundRecipient: recipient, tokenRecipient: recipient, salt: crypto.getRandomValues(new Uint8Array(32)) };
    },
    async mintTestPaymentCoin(depositLot: bigint, onStage: (stage: Stage) => void) {
      if (depositLot <= 0n) throw new Error('Invalid test deposit');
      const state = await publicDataProvider.queryContractState(address as ContractAddress);
      if (!state) throw new Error('Contract is unavailable');
      const ledger = fairLaunch.ledger(((state as { data?: unknown }).data ?? state) as never);
      if (!ledger.saleInventoryFunded || ledger.cancelled || ledger.settled || BigInt(Math.floor(Date.now() / 1000)) >= ledger.commitDeadline) {
        throw new Error('This auction is not accepting test bids');
      }
      if (depositLot !== ledger.depositLot) throw new Error('Deposit does not match the contract lot');
      const { submitted, blockHeight } = await confirmedCall('mintTestPaymentCoin',
        [depositLot, crypto.getRandomValues(new Uint8Array(32))], onStage);
      const coin = (submitted.callTxData as { private?: { result?: unknown } }).private?.result as CoinRecord | undefined;
      if (!coin || !(coin.nonce instanceof Uint8Array) || !(coin.color instanceof Uint8Array) || coin.value !== depositLot) {
        throw new Error('Confirmed mint did not return its payment coin record');
      }
      return { txId: submitted.txId, blockHeight, coin };
    },
    async registerBid(slot: number, opening: fairLaunch.BidOpening, coin: CoinRecord, onStage: (stage: Stage) => void) {
      if (!Number.isInteger(slot) || slot < 0 || slot > 3) throw new Error('Invalid bid slot');
      const state = await publicDataProvider.queryContractState(address as ContractAddress);
      if (!state) throw new Error('Contract is unavailable');
      const ledger = fairLaunch.ledger(((state as { data?: unknown }).data ?? state) as never);
      if (!ledger.saleInventoryFunded || ledger.cancelled || ledger.settled || BigInt(Math.floor(Date.now() / 1000)) >= ledger.commitDeadline) {
        throw new Error('This auction is not accepting test bids');
      }
      if (ledger.registeredBidCount !== BigInt(slot)) throw new Error('Bid slot was filled by another transaction');
      if (opening.maxPrice < ledger.reservePrice || opening.quantity <= 0n || opening.maxPrice * opening.quantity > ledger.depositLot) {
        throw new Error('Bid price or quantity is outside the deposit rules');
      }
      const ownKey = encodeCoinPublicKey(keys.shieldedCoinPublicKey);
      if (toHex(opening.refundRecipient.bytes) !== toHex(ownKey) || toHex(opening.tokenRecipient.bytes) !== toHex(ownKey)) {
        throw new Error('This browser probe accepts only the connected wallet as recipient');
      }
      if (opening.salt.length !== 32 || coin.nonce.length !== 32 || coin.color.length !== 32 || coin.value !== ledger.depositLot) {
        throw new Error('Invalid opening or test payment coin');
      }
      const commitment = fairLaunch.pureCircuits.computeBidCommitment(
        ledger.networkDomain, encodeContractAddress(address as ContractAddress), BigInt(slot), opening,
      );
      const { submitted, blockHeight } = await confirmedCall('registerBid', [BigInt(slot), opening, coin], onStage);
      const updated = await publicDataProvider.queryContractState(address as ContractAddress);
      if (!updated) throw new Error('Registered transaction has no contract readback');
      const result = fairLaunch.ledger(((updated as { data?: unknown }).data ?? updated) as never);
      const recorded = result[`slot${slot}Commitment` as keyof typeof result];
      const funded = result[`slot${slot}Funded` as keyof typeof result];
      if (result.registeredBidCount < BigInt(slot + 1) || funded !== true || !(recorded instanceof Uint8Array) || toHex(recorded) !== toHex(commitment)) {
        throw new Error('Registered transaction did not match the on-chain commitment readback');
      }
      return { txId: submitted.txId, blockHeight, commitment: toHex(commitment) };
    },
  };
}
