import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocket } from 'ws';
import {
  createCallTxOptions,
  createUnprovenDeployTx,
  submitCallTxAsync,
  submitTxAsync,
} from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { encodeCoinPublicKey, encodeContractAddress, sampleSigningKey } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { nativeToken, ZswapSecretKeys } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { createKeystore, HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk';
import { localTestNetwork } from '../../../src/chain/client.js';
import { createSilenceWallet } from '../../../src/chain/wallet.js';
import {
  RecoveryStore,
  readRecoveryStatus,
  refuseExistingRecovery,
  type RecoveryManifest,
} from './recovery-manifest.js';

Reflect.set(globalThis as object, 'WebSocket', WebSocket);

const spikeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = resolve(spikeDir, '../..');
const artifactsDir = resolve(spikeDir, 'generated/two_stage_claim');
const evidencePath = resolve(spikeDir, 'docs/evidence/local-chain.json');
const recoveryDirectory = resolve(projectRoot, '.local/two-stage-claim');
const recoveryOwnerDir = join(recoveryDirectory, 'owner-wallet');
const recoveryOperatorDir = join(recoveryDirectory, 'operator-wallet');
const network = {
  networkId: 'undeployed' as const,
  indexer: process.env.SILENCE_INDEXER_URL ?? 'http://127.0.0.1:28088/api/v4/graphql',
  indexerWS: process.env.SILENCE_INDEXER_WS_URL ?? 'ws://127.0.0.1:28088/api/v4/graphql/ws',
  node: process.env.SILENCE_NODE_URL ?? 'ws://127.0.0.1:29944',
  proofServer: process.env.SILENCE_PROOF_SERVER_URL ?? 'http://127.0.0.1:26300',
};

function assertLocalNetworkOnly(): void {
  const endpoints = [network.indexer, network.indexerWS, network.node, network.proofServer];
  if (endpoints.some((endpoint) => !['127.0.0.1', 'localhost'].includes(new URL(endpoint).hostname))) {
    throw new Error('Two-stage chain acceptance runner is restricted to the local loopback Devnet.');
  }
}

const LOT_ATOMS = 1_000_000_000n;
const TERMS = {
  side: true,
  notionalAtoms: 4_000_000_000n,
  entryPriceTicks: 65_000_000_000n,
  guardBufferAtoms: 20_000_000n,
};

interface Receipt {
  readonly txId: string;
  readonly status: 'SucceedEntirely';
  readonly blockHeight: number;
}

interface IndexedTransaction {
  readonly hash: string;
  readonly raw: string;
  readonly block: { readonly height: number };
  readonly contractActions: readonly {
    readonly address: string;
    readonly entryPoint?: string;
    readonly state: string;
    readonly zswapState: string;
  }[];
}

type WalletContext = Awaited<ReturnType<typeof createSilenceWallet>> & {
  readonly unshieldedKeystore: ReturnType<typeof createKeystore>;
};

let activeStage = 'startup';
let recoveryStore: RecoveryStore | undefined;

type DynamicContractModule = {
  readonly Contract: new (...args: unknown[]) => unknown;
  readonly pureCircuits: {
    deriveOperatorIdentity(
      networkDomain: Uint8Array,
      contractAddress: Uint8Array,
      operatorCloseSecret: Uint8Array,
    ): Uint8Array;
  };
  readonly ledger: (state: unknown) => {
    readonly escrowCoin: { readonly value: bigint; readonly mt_index: bigint };
    readonly ownerIdentityCommitment: Uint8Array;
    readonly operatorIdentityCommitment: Uint8Array;
    readonly ownerRecipientCommitment: Uint8Array;
    readonly positionCommitment: Uint8Array;
    readonly positionActive: boolean;
    readonly closedUnclaimed: boolean;
    readonly settled: boolean;
  };
};

function bytesToHex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function bigIntHex(value: bigint, littleEndian: boolean): string {
  const bytes = new Uint8Array(8);
  let remaining = value;
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[littleEndian ? index : bytes.length - index - 1] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytesToHex(bytes);
}

function containsBytes(publicHex: string, secret: Uint8Array): boolean {
  return publicHex.toLowerCase().includes(bytesToHex(secret).toLowerCase());
}

function containsInteger(publicHex: string, value: bigint): boolean {
  return publicHex.toLowerCase().includes(bigIntHex(value, true)) ||
    publicHex.toLowerCase().includes(bigIntHex(value, false));
}

function publicReceipt(data: { readonly txId: string; readonly status: string; readonly blockHeight?: number }): Receipt {
  assert.equal(data.status, 'SucceedEntirely', 'Transaction ' + data.txId + ' did not succeed: ' + data.status);
  assert.equal(typeof data.blockHeight, 'number', 'Finalized receipt has no block height.');
  return { txId: data.txId, status: 'SucceedEntirely', blockHeight: data.blockHeight! };
}

async function waitForReceipt(provider: ReturnType<typeof indexerPublicDataProvider>, txId: string): Promise<Receipt> {
  return publicReceipt(await provider.watchForTxData(txId));
}

async function queryPublicTransaction(
  indexerUrl: string,
  txId: string,
  expectedBlockHeight: number,
): Promise<IndexedTransaction> {
  const identifier = txId.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{66}$/.test(identifier)) {
    throw new Error('SDK transaction identifier is not a 33-byte indexer identifier.');
  }
  const query = 'query TwoStageTransaction { transactions(offset: { identifier: ' +
    JSON.stringify(identifier) +
    ' }) { hash raw block { height } contractActions { __typename ... on ContractCall { address entryPoint state zswapState } } } }';
  const response = await fetch(indexerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) throw new Error('Local indexer query failed with HTTP ' + response.status + '.');
  const body = await response.json() as {
    readonly data?: { readonly transactions?: readonly IndexedTransaction[] };
    readonly errors?: readonly { readonly message: string }[];
  };
  if (body.errors?.length) throw new Error('Local indexer query was rejected: ' + body.errors[0]?.message);
  const transaction = body.data?.transactions?.[0];
  if (!transaction || typeof transaction.raw !== 'string') throw new Error('Finalized raw transaction is missing from indexer.');
  assert.equal(transaction.block.height, expectedBlockHeight, 'Indexed block differs from receipt.');
  return transaction;
}

async function makeProviders(
  wallet: WalletContext,
  walletDir: string,
  contractModule: DynamicContractModule,
  privateStoragePassword: string,
  feeSponsor?: WalletContext,
) {
  const zkConfigProvider = new NodeZkConfigProvider(artifactsDir);
  const publicDataProvider = indexerPublicDataProvider(network.indexer, network.indexerWS);
  const sponsor = feeSponsor ?? wallet;
  const sponsoringAnotherWallet = sponsor !== wallet;
  const walletProvider = {
    getCoinPublicKey: () => wallet.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => wallet.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: unknown, ttl?: Date) {
      // The current user identity remains the operator shielded key. Only DUST
      // fee inputs use the owner's local test wallet in sponsor mode.
      const recipe = await sponsor.wallet.balanceUnboundTransaction(
        tx as never,
        { shieldedSecretKeys: wallet.shieldedSecretKeys, dustSecretKey: sponsor.dustSecretKey },
        {
          ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000),
          tokenKindsToBalance: sponsoringAnotherWallet ? ['dust'] : 'all',
        },
      );
      return sponsor.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: unknown) => sponsor.wallet.submitTransaction(tx as never),
  };
  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      accountId: wallet.unshieldedKeystore.getBech32Address().toString(),
      midnightDbName: join(walletDir, 'midnight-level-db'),
      privateStateStoreName: 'silence-two-stage-private-state',
      signingKeyStoreName: 'silence-two-stage-signing-keys',
      privateStoragePasswordProvider: () => privateStoragePassword,
    }),
    publicDataProvider,
    zkConfigProvider,
    proofProvider: httpClientProofProvider(network.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  } as const;
  return { providers, publicDataProvider, zkConfigProvider, walletProvider };
}

async function createTestWallet(seedHex: string, walletDir: string, privateStoragePassword: string): Promise<WalletContext> {
  const config = {
    ...localTestNetwork(privateStoragePassword),
    privateStateDir: join(walletDir, 'private-state'),
  };
  const context = await createSilenceWallet(seedHex, config);
  const hdWallet = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Local test wallet seed was rejected.');
  const derivation = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derivation.type !== 'keysDerived') {
    hdWallet.hdWallet.clear();
    throw new Error('Local test wallet role keys could not be derived.');
  }
  const keys = derivation.keys;
  hdWallet.hdWallet.clear();
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], config.networkId);
  if (unshieldedKeystore.getBech32Address().toString() !== context.accountId) {
    await context.stop();
    throw new Error('Local test wallet address did not match the configured SDK wallet.');
  }
  return { ...context, unshieldedKeystore };
}

async function invoke(
  recovery: RecoveryStore,
  providers: Awaited<ReturnType<typeof makeProviders>>['providers'],
  publicDataProvider: ReturnType<typeof indexerPublicDataProvider>,
  compiledContract: unknown,
  address: string,
  circuit: string,
  args: readonly unknown[] = [],
  expectedProofRejection = false,
) {
  recovery.beginOperation(circuit);
  const options = createCallTxOptions(
    compiledContract as never,
    circuit as never,
    address as never,
    undefined,
    undefined,
    [...args] as never,
  );
  let submitted: Awaited<ReturnType<typeof submitCallTxAsync>>;
  try {
    submitted = await submitCallTxAsync(providers as never, options as never);
  } catch (error) {
    const diagnostic = safeDiagnostic(error);
    if (expectedProofRejection && diagnostic.includes('failed assert:')) {
      recovery.recordProofRejection(circuit, diagnostic);
    } else {
      recovery.markInterrupted(diagnostic);
    }
    throw error;
  }
  recovery.recordSubmitted(circuit, submitted.txId);
  let receipt: Receipt;
  try {
    receipt = await waitForReceipt(publicDataProvider, submitted.txId);
  } catch (error) {
    recovery.markInterrupted(safeDiagnostic(error));
    throw error;
  }
  recovery.recordReceipt(circuit, receipt, phaseAfterCircuit(circuit, recovery.snapshot.phase));
  return {
    receipt,
    privateResult: (submitted.callTxData as { readonly private: { readonly result: unknown } }).private.result,
  };
}

function phaseAfterCircuit(circuit: string, current: RecoveryManifest['phase']): RecoveryManifest['phase'] {
  switch (circuit) {
    case 'openPosition': return 'position_open';
    case 'operatorClose': return 'closed_unclaimed';
    case 'ownerClaim': return 'claimed';
    case 'mintTestCollateral': return current;
    default: return current;
  }
}

function deriveShieldedCoinPublicKey(seedHex: string): string {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Local test wallet seed was rejected.');
  const derivation = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derivation.type !== 'keysDerived') {
    hdWallet.hdWallet.clear();
    throw new Error('Local test wallet role keys could not be derived.');
  }
  const zswapKeys = ZswapSecretKeys.fromSeed(derivation.keys[Roles.Zswap]);
  const publicKey = bytesToHex(encodeCoinPublicKey(zswapKeys.coinPublicKey));
  hdWallet.hdWallet.clear();
  return publicKey;
}

async function readLedger(provider: ReturnType<typeof indexerPublicDataProvider>, module: DynamicContractModule, address: string) {
  const state = await provider.queryContractState(address as never);
  assert.ok(state, 'Contract state unavailable from public indexer.');
  return module.ledger((state as { readonly data?: unknown }).data ?? state);
}

async function shieldedBalance(wallet: WalletContext, tokenColor: string): Promise<bigint> {
  const state = await wallet.wallet.waitForSyncedState();
  return state.shielded.balances[tokenColor] ?? 0n;
}

async function main(): Promise<void> {
  if (process.env.SILENCE_TWO_STAGE_RECOVERY_STATUS === '1') {
    const status = readRecoveryStatus(recoveryDirectory);
    process.stdout.write(JSON.stringify(status ?? { phase: 'no-recovery-record' }) + '\n');
    return;
  }
  refuseExistingRecovery(recoveryDirectory);
  let ownerSeed = process.env.SILENCE_LOCAL_TEST_SEED?.trim() ?? '';
  delete process.env.SILENCE_LOCAL_TEST_SEED;
  if (!/^(?:[0-9a-fA-F]{2}){16,64}$/.test(ownerSeed)) {
    throw new Error('Set SILENCE_LOCAL_TEST_SEED to a funded, valueless Local Devnet test seed; Preprod/developer wallet seeds are not accepted by this runner.');
  }
  assertLocalNetworkOnly();
  const proofServerResponse = await fetch(network.proofServer, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (!proofServerResponse) throw new Error('Shared isolated Local Devnet proof server is unavailable; this runner will not start or reset it.');

  setNetworkId(network.networkId);
  let operatorSeed = randomBytes(32).toString('hex');
  const storagePassword = randomBytes(32).toString('hex');
  const ownerCloseSecret = randomBytes(32);
  const operatorCloseSecret = randomBytes(32);
  const positionSalt = randomBytes(32);
  const recipientSalt = randomBytes(32);
  const mintNonce = randomBytes(32);
  const ownerKeyHex = deriveShieldedCoinPublicKey(ownerSeed);
  const operatorKeyHex = deriveShieldedCoinPublicKey(operatorSeed);
  const initialContractAddress = process.env.SILENCE_TWO_STAGE_CONTRACT_ADDRESS?.trim() || null;
  const contractMaintenanceSigningKey = initialContractAddress ? null : sampleSigningKey();
  recoveryStore = RecoveryStore.create(recoveryDirectory, {
    version: 1,
    runId: randomBytes(16).toString('hex'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: 'prepared',
    contractAddress: initialContractAddress,
    contractMaintenanceSigningKey,
    ownerSeedHex: ownerSeed,
    operatorSeedHex: operatorSeed,
    privateStoragePassword: storagePassword,
    terms: {
      side: TERMS.side,
      notionalAtoms: TERMS.notionalAtoms.toString(),
      entryPriceTicks: TERMS.entryPriceTicks.toString(),
      guardBufferAtoms: TERMS.guardBufferAtoms.toString(),
    },
    positionSaltHex: bytesToHex(positionSalt),
    ownerCloseSecretHex: bytesToHex(ownerCloseSecret),
    operatorCloseSecretHex: bytesToHex(operatorCloseSecret),
    ownerRecipientCoinPublicKeyHex: ownerKeyHex,
    operatorCoinPublicKeyHex: operatorKeyHex,
    recipientSaltHex: bytesToHex(recipientSalt),
    mintNonceHex: bytesToHex(mintNonce),
    pendingOperation: null,
    pendingTxId: null,
    receipts: {},
    negativeChecks: [],
  });
  const ownerDir = recoveryOwnerDir;
  const operatorDir = recoveryOperatorDir;
  mkdirSync(ownerDir, { recursive: true, mode: 0o700 });
  mkdirSync(operatorDir, { recursive: true, mode: 0o700 });
  let ownerWallet: WalletContext | undefined;
  let operatorWallet: WalletContext | undefined;
  let completeRun = false;

  try {
    activeStage = 'owner-wallet-start';
    ownerWallet = await createTestWallet(ownerSeed, ownerDir, storagePassword);
    ownerSeed = '';
    activeStage = 'operator-wallet-start';
    operatorWallet = await createTestWallet(operatorSeed, operatorDir, storagePassword);
    operatorSeed = '';

    activeStage = 'wallet-sync-and-preflight';
    await ownerWallet.wallet.waitForSyncedState();
    await operatorWallet.wallet.waitForSyncedState();
    const ownerStateBefore = await ownerWallet.wallet.waitForSyncedState();
    const operatorStateBefore = await operatorWallet.wallet.waitForSyncedState();
    const localNight = nativeToken().raw;
    const ownerNightBefore = ownerStateBefore.unshielded.balances[localNight] ?? 0n;
    const ownerDustBefore = ownerStateBefore.dust.balance(new Date());
    const operatorNightBefore = operatorStateBefore.unshielded.balances[localNight] ?? 0n;
    if (ownerDustBefore <= 0n) {
      throw new Error('Owner fee-sponsor preflight failed: no local DUST balance is available; no transaction was built.');
    }
    if (operatorNightBefore !== 0n) {
      throw new Error('Fresh operator test wallet unexpectedly has a native-token balance; refusing a mixed-funded run.');
    }
    const ownerKey = encodeCoinPublicKey(ownerWallet.shieldedSecretKeys.coinPublicKey);
    const operatorKey = encodeCoinPublicKey(operatorWallet.shieldedSecretKeys.coinPublicKey);
    assert.notDeepEqual(operatorKey, ownerKey, 'Owner and operator must be distinct shielded wallets.');
    assert.equal(bytesToHex(ownerKey), ownerKeyHex, 'Owner shielded key changed after recovery record creation.');
    assert.equal(bytesToHex(operatorKey), operatorKeyHex, 'Operator shielded key changed after recovery record creation.');

    const modulePath = resolve(artifactsDir, 'contract/index.js');
    const contractModule = await import(pathToFileURL(modulePath).href) as DynamicContractModule;
    const compiledContract = CompiledContract.make('silence-two-stage-claim', contractModule.Contract as never).pipe(
      CompiledContract.withWitnesses({} as never),
      CompiledContract.withCompiledFileAssets(artifactsDir),
    );
    const ownerRuntime = await makeProviders(ownerWallet, ownerDir, contractModule, storagePassword);
    const operatorRuntime = await makeProviders(operatorWallet, operatorDir, contractModule, storagePassword, ownerWallet);

    let contractAddress = process.env.SILENCE_TWO_STAGE_CONTRACT_ADDRESS?.trim() ?? '';
    let deployment: Receipt | null = null;
    if (contractAddress) {
      activeStage = 'existing-contract-readback';
      const existingState = await ownerRuntime.publicDataProvider.queryContractState(contractAddress as never);
      assert.ok(existingState, 'Configured existing Local Devnet contract was not found.');
      const existingLedger = contractModule.ledger((existingState as { readonly data?: unknown }).data ?? existingState);
      assert.equal(existingLedger.positionActive, false, 'Refusing to reuse a contract with an active position.');
      assert.equal(existingLedger.closedUnclaimed, false, 'Refusing to reuse a contract with pending funds.');
      assert.equal(existingLedger.settled, false, 'Refusing to reuse a settled contract.');
    } else {
      activeStage = 'deploy';
      recoveryStore!.beginOperation('deploy');
      const deployData = await createUnprovenDeployTx(
        { zkConfigProvider: ownerRuntime.zkConfigProvider, walletProvider: ownerRuntime.walletProvider } as never,
        {
          compiledContract: compiledContract as never,
          args: [createHash('sha256').update('SILENCE/TWO-STAGE/LOCAL-DEVNET/v1').digest()],
          signingKey: contractMaintenanceSigningKey ?? sampleSigningKey(),
          initialPrivateState: undefined,
        } as never,
      );
      contractAddress = String(deployData.public.contractAddress);
      recoveryStore!.update({ contractAddress });
      let deploymentId: string;
      try {
        deploymentId = await submitTxAsync(
          ownerRuntime.providers as never,
          { unprovenTx: deployData.private.unprovenTx } as never,
        );
      } catch (error) {
        recoveryStore!.markInterrupted(safeDiagnostic(error));
        throw error;
      }
      recoveryStore!.recordSubmitted('deploy', deploymentId);
      try {
        deployment = await waitForReceipt(ownerRuntime.publicDataProvider, deploymentId);
      } catch (error) {
        recoveryStore!.markInterrupted(safeDiagnostic(error));
        throw error;
      }
      recoveryStore!.recordReceipt('deploy', deployment, 'prepared');
    }
    ownerRuntime.providers.privateStateProvider.setContractAddress(contractAddress as never);
    operatorRuntime.providers.privateStateProvider.setContractAddress(contractAddress as never);

    const ownerTarget = { ownerRecipient: { bytes: ownerKey }, recipientSalt };
    const networkDomain = createHash('sha256').update('SILENCE/TWO-STAGE/LOCAL-DEVNET/v1').digest();
    const operatorIdentity = contractModule.pureCircuits.deriveOperatorIdentity(
      networkDomain,
      encodeContractAddress(contractAddress as never),
      operatorCloseSecret,
    );

    activeStage = 'mint-test-collateral';
    const mint = await invoke(recoveryStore!, ownerRuntime.providers, ownerRuntime.publicDataProvider, compiledContract, contractAddress, 'mintTestCollateral', [mintNonce]);
    const mintedCoin = mint.privateResult as { readonly nonce: Uint8Array; readonly color: Uint8Array; readonly value: bigint };
    recoveryStore!.update({
      mintedCoin: {
        nonceHex: bytesToHex(mintedCoin.nonce),
        colorHex: bytesToHex(mintedCoin.color),
        value: mintedCoin.value.toString(),
      },
    });
    assert.equal(mintedCoin.value, LOT_ATOMS, 'Test mint returned the wrong fixed collateral lot.');
    const tokenColor = bytesToHex(mintedCoin.color);

    activeStage = 'owner-open';
    const opened = await invoke(recoveryStore!, ownerRuntime.providers, ownerRuntime.publicDataProvider, compiledContract, contractAddress, 'openPosition', [
      mintedCoin,
      TERMS,
      positionSalt,
      ownerCloseSecret,
      operatorIdentity,
      ownerTarget,
    ]);
    const openState = await readLedger(ownerRuntime.publicDataProvider, contractModule, contractAddress);
    assert.equal(openState.positionActive, true);
    assert.equal(openState.closedUnclaimed, false);
    assert.equal(openState.settled, false);
    assert.equal(openState.escrowCoin.value, LOT_ATOMS);
    assert.ok(openState.escrowCoin.mt_index > 0n);
    assert.equal(await shieldedBalance(ownerWallet, tokenColor), 0n);

    const openIndexed = await queryPublicTransaction(network.indexer, opened.receipt.txId, opened.receipt.blockHeight);
    const openAction = openIndexed.contractActions.find((action) => action.entryPoint === 'openPosition');
    assert.ok(openAction, 'Indexer is missing the finalized openPosition action.');
    const openPublic = [openIndexed.raw, openAction.state, openAction.zswapState].join('').replace(/^0x/gi, '').toLowerCase();
    const termsVisible = containsBytes(openPublic, ownerCloseSecret) ||
      containsBytes(openPublic, operatorCloseSecret) ||
      containsBytes(openPublic, positionSalt) ||
      containsBytes(openPublic, recipientSalt) ||
      containsBytes(openPublic, ownerKey) ||
      Object.values(TERMS).some((value) => typeof value === 'bigint' && containsInteger(openPublic, value));
    assert.equal(termsVisible, false, 'Open transaction public fields contain a tested private witness or recipient key.');

    activeStage = 'operator-close';
    const closed = await invoke(recoveryStore!, operatorRuntime.providers, operatorRuntime.publicDataProvider, compiledContract, contractAddress, 'operatorClose', [operatorCloseSecret]);
    const closedState = await readLedger(operatorRuntime.publicDataProvider, contractModule, contractAddress);
    assert.equal(closedState.positionActive, false);
    assert.equal(closedState.closedUnclaimed, true);
    assert.equal(closedState.settled, false);
    assert.equal(closedState.escrowCoin.value, LOT_ATOMS);
    assert.equal(closedState.escrowCoin.mt_index, openState.escrowCoin.mt_index);
    assert.equal(await shieldedBalance(ownerWallet, tokenColor), 0n, 'Operator close paid the owner before their claim.');
    assert.equal(await shieldedBalance(operatorWallet, tokenColor), 0n, 'Operator close redirected collateral to the operator wallet.');

    const closeIndexed = await queryPublicTransaction(network.indexer, closed.receipt.txId, closed.receipt.blockHeight);
    const closeAction = closeIndexed.contractActions.find((action) => action.entryPoint === 'operatorClose');
    assert.ok(closeAction, 'Indexer is missing the finalized operatorClose action.');
    const closePublic = [closeIndexed.raw, closeAction.state, closeAction.zswapState].join('').replace(/^0x/gi, '').toLowerCase();
    assert.equal(containsBytes(closePublic, operatorCloseSecret), false, 'Operator secret appears in public transaction fields.');
    assert.equal(containsBytes(closePublic, ownerKey), false, 'Owner payout key appears in operator close public fields.');

    activeStage = 'operator-claim-negative';
    let operatorClaimRejected = false;
    let operatorClaimRejection = 'No rejection diagnostic.';
    try {
      await invoke(recoveryStore!, operatorRuntime.providers, operatorRuntime.publicDataProvider, compiledContract, contractAddress, 'ownerClaim', [
        TERMS,
        positionSalt,
        operatorCloseSecret,
        ownerTarget,
      ], true);
    } catch (error) {
      operatorClaimRejected = true;
      operatorClaimRejection = (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, 240) ?? 'Rejected without a diagnostic.';
    }
    assert.equal(operatorClaimRejected, true, 'Independent operator wallet unexpectedly submitted a successful owner claim.');
    const afterOperatorAttempt = await readLedger(operatorRuntime.publicDataProvider, contractModule, contractAddress);
    assert.equal(afterOperatorAttempt.closedUnclaimed, true);
    assert.equal(afterOperatorAttempt.settled, false);
    assert.equal(await shieldedBalance(operatorWallet, tokenColor), 0n);

    activeStage = 'owner-claim';
    const ownerClaim = await invoke(recoveryStore!, ownerRuntime.providers, ownerRuntime.publicDataProvider, compiledContract, contractAddress, 'ownerClaim', [
      TERMS,
      positionSalt,
      ownerCloseSecret,
      ownerTarget,
    ]);
    await ownerWallet.wallet.waitForSyncedState();
    await operatorWallet.wallet.waitForSyncedState();
    const claimedState = await readLedger(ownerRuntime.publicDataProvider, contractModule, contractAddress);
    const ownerBalanceAfterClaim = await shieldedBalance(ownerWallet, tokenColor);
    const operatorBalanceAfterClaim = await shieldedBalance(operatorWallet, tokenColor);
    assert.equal(claimedState.positionActive, false);
    assert.equal(claimedState.closedUnclaimed, false);
    assert.equal(claimedState.settled, true);
    assert.equal(ownerBalanceAfterClaim, LOT_ATOMS, 'Owner did not receive the committed fixed lot after claim.');
    assert.equal(operatorBalanceAfterClaim, 0n, 'Operator received any of the collateral lot.');

    const claimIndexed = await queryPublicTransaction(network.indexer, ownerClaim.receipt.txId, ownerClaim.receipt.blockHeight);
    const claimAction = claimIndexed.contractActions.find((action) => action.entryPoint === 'ownerClaim');
    assert.ok(claimAction, 'Indexer is missing the finalized ownerClaim action.');
    const claimPublic = [claimIndexed.raw, claimAction.state, claimAction.zswapState].join('').replace(/^0x/gi, '').toLowerCase();
    assert.equal(containsBytes(claimPublic, ownerCloseSecret), false);
    assert.equal(containsBytes(claimPublic, ownerKey), false, 'Committed shielded recipient key appears in owner claim public fields.');

    let duplicateOperatorCloseRejected = false;
    try {
      await invoke(recoveryStore!, operatorRuntime.providers, operatorRuntime.publicDataProvider, compiledContract, contractAddress, 'operatorClose', [operatorCloseSecret], true);
    } catch {
      duplicateOperatorCloseRejected = true;
    }
    assert.equal(duplicateOperatorCloseRejected, true, 'Duplicate operator close unexpectedly succeeded.');

    let duplicateOwnerClaimRejected = false;
    try {
      await invoke(recoveryStore!, ownerRuntime.providers, ownerRuntime.publicDataProvider, compiledContract, contractAddress, 'ownerClaim', [
        TERMS,
        positionSalt,
        ownerCloseSecret,
        ownerTarget,
      ], true);
    } catch {
      duplicateOwnerClaimRejected = true;
    }
    assert.equal(duplicateOwnerClaimRejected, true, 'Duplicate owner claim unexpectedly succeeded.');
    const finalState = await readLedger(ownerRuntime.publicDataProvider, contractModule, contractAddress);
    assert.equal(finalState.settled, true);
    assert.equal(await shieldedBalance(ownerWallet, tokenColor), LOT_ATOMS);

    const evidence = {
      checkedAt: new Date().toISOString(),
      mode: 'actual-shared-local-devnet-two-distinct-wallets',
      contractAddress,
      walletSeparation: {
        ownerAndOperatorShieldedKeysDiffer: !Buffer.from(ownerKey).equals(Buffer.from(operatorKey)),
        operatorKeyMatchesCommittedRecipient: Buffer.from(ownerKey).equals(Buffer.from(operatorKey)),
        note: 'The operator secret was used by an independent wallet; no user Preprod/development wallet seed was loaded.',
      },
      receipts: {
        deployment,
        open: opened.receipt,
        operatorClose: closed.receipt,
        ownerClaim: ownerClaim.receipt,
      },
      observations: {
        ownerNativeBalanceBeforeAttemptStar: ownerNightBefore.toString(),
        operatorNativeBalanceBeforeAttemptStar: operatorNightBefore.toString(),
        ownerHadLocalDustForFee: ownerDustBefore > 0n,
        operatorCloseDUSTFeeSponsoredByOwner: true,
        publicFixedCollateralAtoms: openState.escrowCoin.value.toString(),
        collateralMerkleIndex: openState.escrowCoin.mt_index.toString(),
        ownerShieldedBalanceAfterOpen: '0',
        operatorShieldedBalanceAfterOperatorClose: '0',
        operatorOwnerClaimAttemptRejected: operatorClaimRejected,
        operatorClaimRejection,
        stateAfterOperatorClose: {
          positionActive: closedState.positionActive,
          closedUnclaimed: closedState.closedUnclaimed,
          settled: closedState.settled,
          escrowValueAtoms: closedState.escrowCoin.value.toString(),
          escrowMerkleIndex: closedState.escrowCoin.mt_index.toString(),
        },
        ownerShieldedBalanceAfterClaim: ownerBalanceAfterClaim.toString(),
        operatorShieldedBalanceAfterClaim: operatorBalanceAfterClaim.toString(),
        ownerAndOperatorReplayAttemptsRejected: duplicateOperatorCloseRejected && duplicateOwnerClaimRejected,
        testedPublicFieldsExcludeOpenWitnessesAndOwnerAddress: !termsVisible,
        testedPublicFieldsExcludeOperatorSecretAndOwnerAddressAtClose: !containsBytes(closePublic, operatorCloseSecret) && !containsBytes(closePublic, ownerKey),
        testedPublicFieldsExcludeOwnerSecretAndRecipientAddressAtClaim: !containsBytes(claimPublic, ownerCloseSecret) && !containsBytes(claimPublic, ownerKey),
      },
      limitations: [
        'This is a valueless Local Devnet contract test using two distinct wallets. It is not a Preprod or production transaction.',
        'The operator uses a separate shielded key, but the owner wallet Local Devnet DUST pays its transaction fee. This verifies the caller-key/recipient-key boundary, not independently funded operator fee authority.',
        'The recovery record keeps the test-only owner/operator seeds, owner storage password, close capabilities, recipient and position witnesses, and receipts on disk with owner-only permissions until the complete claim/readback passes.',
        'It proves close/claim authority separation and fixed-lot shielded owner readback only; it does not prove oracle pricing, PnL, automated liquidation, safe real-value custody, or a complete perp DEX.',
        'The operator capability has no risk predicate in this spike and can close early at any time.',
        'Only tested raw transaction and indexed contract-action fields were searched for the listed private witnesses; this is not a general privacy audit.',
      ],
    };
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    recoveryStore!.update({
      phase: 'complete',
      lastKnownPhase: undefined,
      pendingOperation: null,
      pendingTxId: null,
      lastDiagnostic: undefined,
    });
    completeRun = true;
    process.stdout.write(
      'PASS: owner/open → separate operator-key/owner-DUST-sponsored close → rejected operator claim → owner/claim; finalized receipts ' +
      [...(deployment ? [deployment.txId] : []), opened.receipt.txId, closed.receipt.txId, ownerClaim.receipt.txId].join(', ') +
      '; owner shielded balance=' + ownerBalanceAfterClaim + ' fixed test atoms; operator balance=' + operatorBalanceAfterClaim + '.\n',
    );
  } finally {
    operatorSeed = '';
    ownerSeed = '';
    await Promise.allSettled([
      ownerWallet?.wallet.stop(),
      operatorWallet?.wallet.stop(),
    ]);
    if (completeRun) recoveryStore!.removeAfterVerifiedComplete();
  }
}

function safeDiagnostic(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      break;
    }
  }
  return parts
    .join(' <- ')
    .replace(/[0-9a-f]{32,}/gi, '[hex redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, 500) || 'Unknown Local Devnet error.';
}

try {
  await main();
} catch (error) {
  if (recoveryStore && recoveryStore.snapshot.phase !== 'complete') {
    recoveryStore.markInterrupted(safeDiagnostic(error));
  }
  process.stderr.write('FAIL stage=' + activeStage + ': ' + safeDiagnostic(error) + '\n');
  process.exitCode = 1;
}
