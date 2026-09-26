import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import { encodeCoinPublicKey, sampleSigningKey } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { HDWallet, Roles, createKeystore } from '@midnight-ntwrk/wallet-sdk';

import { localTestNetwork } from '../../../src/chain/client.js';
import { createSilenceWallet } from '../../../src/chain/wallet.js';

Reflect.set(globalThis as object, 'WebSocket', WebSocket);

const spikeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactsDir = resolve(spikeDir, 'generated/lp_claim_discriminator');
const selectedCase = process.env.SILENCE_LP_CLAIM_CASE?.trim() ?? '';
const evidencePath = resolve(spikeDir,
  selectedCase === 'D-variable' ? 'docs/evidence/local-chain-D.json'
    : selectedCase === 'E-two-coin' ? 'docs/evidence/local-chain-E.json'
      : 'docs/evidence/local-chain.json');
const recoveryRoot = resolve(spikeDir, '.local/recovery');
const recoveryPath = join(recoveryRoot, 'manifest.json');
const walletDir = join(recoveryRoot, 'owner-wallet');
const network = {
  networkId: 'undeployed' as const,
  indexer: process.env.SILENCE_INDEXER_URL ?? 'http://127.0.0.1:28088/api/v4/graphql',
  indexerWS: process.env.SILENCE_INDEXER_WS_URL ?? 'ws://127.0.0.1:28088/api/v4/graphql/ws',
  node: process.env.SILENCE_NODE_URL ?? 'ws://127.0.0.1:29944',
  proofServer: process.env.SILENCE_PROOF_SERVER_URL ?? 'http://127.0.0.1:26300',
};
const COLLATERAL = 1000n;
const PARTIAL_PAYOUT = 800n;
const REQUIRED_DUST_BUFFER = 5_000_000_000_000_000n;

type Receipt = { readonly txId: string; readonly status: 'SucceedEntirely'; readonly blockHeight: number };
type WalletContext = Awaited<ReturnType<typeof createSilenceWallet>> & {
  readonly unshieldedKeystore: ReturnType<typeof createKeystore>;
};
type RecoveryManifest = {
  readonly version: 1;
  readonly createdAt: string;
  readonly credentials: { readonly ownerSeedHex: string; readonly privateStoragePassword: string };
  phase: string;
  status: 'pending' | 'uncertain';
  submissionStarted: boolean;
  readonly contractAddresses: Record<string, string>;
  readonly receipts: Record<string, Receipt>;
  pendingTransaction?: { readonly stage: string; readonly contractAddress?: string; readonly circuit?: string; txId?: string };
};
type DynamicModule = {
  readonly Contract: new (...args: unknown[]) => unknown;
  readonly ledger: (state: unknown) => {
    readonly escrowCoin: { readonly value: bigint; readonly mt_index: bigint };
    readonly changeCoin: { readonly value: bigint; readonly mt_index: bigint };
    readonly reserveCoin: { readonly value: bigint; readonly mt_index: bigint };
    readonly collateralLocked: boolean;
    readonly changeStored: boolean;
    readonly reserveFunded: boolean;
    readonly settled: boolean;
  };
};

let recovery: RecoveryManifest | null = null;
let privateStoragePassword = '';
let activeStage = 'startup';
let submissionStarted = false;
let safeCleanup = false;
let previousUmask: number | undefined;

function safeDiagnostic(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[0-9a-f]{32,}/gi, '[hex redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, 500) || 'Unknown Local Devnet error.';
}

function assertLoopback(): void {
  const endpoints = [network.indexer, network.indexerWS, network.node, network.proofServer];
  if (endpoints.some((endpoint) => !['127.0.0.1', 'localhost'].includes(new URL(endpoint).hostname))) {
    throw new Error('The claim discriminator only permits loopback Local Devnet endpoints.');
  }
}

function saveRecovery(): void {
  if (!recovery) return;
  const temporary = join(recoveryRoot, 'manifest.tmp-' + process.pid);
  writeFileSync(temporary, JSON.stringify(recovery, null, 2) + '\n', { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, recoveryPath);
  chmodSync(recoveryPath, 0o600);
  assert.equal(statSync(recoveryRoot).mode & 0o777, 0o700);
  assert.equal(statSync(recoveryPath).mode & 0o777, 0o600);
}

function stage(name: string): void {
  activeStage = name;
  if (recovery) {
    recovery.phase = name;
    saveRecovery();
  }
}

function recordReceipt(name: string, value: Receipt): void {
  if (!recovery) throw new Error('Protected recovery manifest missing after finality.');
  recovery.receipts[name] = value;
  recovery.pendingTransaction = undefined;
  activeStage = name + ':finalized';
  recovery.phase = activeStage;
  saveRecovery();
}

async function finalizedReceipt(provider: ReturnType<typeof indexerPublicDataProvider>, txId: string): Promise<Receipt> {
  const receipt = await provider.watchForTxData(txId);
  assert.equal(receipt.status, 'SucceedEntirely', 'Transaction did not finalize successfully: ' + receipt.status);
  assert.equal(typeof receipt.blockHeight, 'number', 'Transaction finality has no block height.');
  return { txId, status: 'SucceedEntirely', blockHeight: receipt.blockHeight! };
}

async function createWallet(seedHex: string): Promise<WalletContext> {
  const config = {
    ...localTestNetwork(privateStoragePassword),
    artifactsDir,
    privateStateDir: join(walletDir, 'private-state'),
  };
  const context = await createSilenceWallet(seedHex, config);
  const hdWallet = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Local test wallet seed was rejected.');
  const derivation = hdWallet.hdWallet.selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derivation.type !== 'keysDerived') {
    hdWallet.hdWallet.clear();
    throw new Error('Local test wallet role keys could not be derived.');
  }
  const unshieldedKeystore = createKeystore(derivation.keys[Roles.NightExternal], config.networkId);
  hdWallet.hdWallet.clear();
  if (unshieldedKeystore.getBech32Address().toString() !== context.accountId) {
    await context.stop();
    throw new Error('Local test wallet address did not match the Local Devnet wallet context.');
  }
  return { ...context, unshieldedKeystore };
}

async function providers(wallet: WalletContext) {
  const zkConfigProvider = new NodeZkConfigProvider(artifactsDir);
  const publicDataProvider = indexerPublicDataProvider(network.indexer, network.indexerWS);
  const walletProvider = {
    getCoinPublicKey: () => wallet.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => wallet.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: unknown, ttl?: Date) {
      const recipe = await wallet.wallet.balanceUnboundTransaction(
        tx as never,
        { shieldedSecretKeys: wallet.shieldedSecretKeys, dustSecretKey: wallet.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      return wallet.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: unknown) => wallet.wallet.submitTransaction(tx as never),
  };
  const providerSet = {
    privateStateProvider: levelPrivateStateProvider({
      accountId: wallet.accountId,
      midnightDbName: join(walletDir, 'midnight-level-db'),
      privateStateStoreName: 'silence-lp-claim-discriminator-private-state',
      signingKeyStoreName: 'silence-lp-claim-discriminator-signing-keys',
      privateStoragePasswordProvider: () => privateStoragePassword,
    }),
    publicDataProvider,
    zkConfigProvider,
    proofProvider: httpClientProofProvider(network.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  } as const;
  return { providerSet, publicDataProvider, zkConfigProvider, walletProvider };
}

async function deploy(
  runtime: Awaited<ReturnType<typeof providers>>,
  compiled: unknown,
  networkDomain: Uint8Array,
  caseName: string,
): Promise<{ readonly address: string; readonly receipt: Receipt }> {
  const deployment = await createUnprovenDeployTx(
    { zkConfigProvider: runtime.zkConfigProvider, walletProvider: runtime.walletProvider } as never,
    {
      compiledContract: compiled as never,
      args: [],
      signingKey: sampleSigningKey(),
      initialPrivateState: undefined,
    } as never,
  );
  const address = String(deployment.public.contractAddress);
  if (!recovery) throw new Error('Recovery manifest missing before deploy.');
  recovery.contractAddresses[caseName] = address;
  submissionStarted = true;
  recovery.submissionStarted = true;
  activeStage = caseName + ':deploy-submit-in-flight';
  recovery.phase = activeStage;
  recovery.pendingTransaction = { stage: activeStage, contractAddress: address };
  saveRecovery();
  const txId = await submitTxAsync(runtime.providerSet as never, { unprovenTx: deployment.private.unprovenTx } as never);
  recovery.pendingTransaction = { ...recovery.pendingTransaction!, txId };
  saveRecovery();
  const receipt = await finalizedReceipt(runtime.publicDataProvider, txId);
  runtime.providerSet.privateStateProvider.setContractAddress(address as never);
  recordReceipt(caseName + ':deploy', receipt);
  return { address, receipt };
}

async function invoke(
  runtime: Awaited<ReturnType<typeof providers>>,
  compiled: unknown,
  address: string,
  circuit: string,
  args: readonly unknown[],
  label: string,
) {
  const options = createCallTxOptions(
    compiled as never,
    circuit as never,
    address as never,
    undefined,
    undefined,
    [...args] as never,
  );
  if (!recovery) throw new Error('Recovery manifest missing before circuit submit.');
  submissionStarted = true;
  recovery.submissionStarted = true;
  activeStage = label + ':submit-in-flight';
  recovery.phase = activeStage;
  recovery.pendingTransaction = { stage: activeStage, contractAddress: address, circuit };
  saveRecovery();
  const submitted = await submitCallTxAsync(runtime.providerSet as never, options as never);
  recovery.pendingTransaction = { ...recovery.pendingTransaction, txId: submitted.txId };
  saveRecovery();
  const receipt = await finalizedReceipt(runtime.publicDataProvider, submitted.txId);
  recordReceipt(label, receipt);
  return {
    receipt,
    privateResult: (submitted.callTxData as { readonly private: { readonly result: unknown } }).private.result,
  };
}

async function readLedger(provider: ReturnType<typeof indexerPublicDataProvider>, module: DynamicModule, address: string) {
  const state = await provider.queryContractState(address as never);
  assert.ok(state, 'Contract state unavailable from Local Devnet indexer.');
  return module.ledger((state as { readonly data?: unknown }).data ?? state);
}

async function shieldedBalance(wallet: WalletContext, color: string): Promise<bigint> {
  const state = await wallet.wallet.waitForSyncedState();
  return state.shielded.balances[color] ?? 0n;
}

function startRecovery(ownerSeed: string): string {
  if (existsSync(recoveryPath)) {
    throw new Error('Unresolved discriminator recovery already exists at ' + recoveryPath + '; inspect it before any new run.');
  }
  if (existsSync(recoveryRoot) && readdirSync(recoveryRoot).length > 0) {
    throw new Error('Unreviewed discriminator recovery directory exists at ' + recoveryRoot + '; refusing overwrite.');
  }
  previousUmask = process.umask(0o077);
  mkdirSync(dirname(recoveryRoot), { recursive: true, mode: 0o700 });
  chmodSync(dirname(recoveryRoot), 0o700);
  mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
  chmodSync(recoveryRoot, 0o700);
  privateStoragePassword = randomBytes(32).toString('hex');
  const record: RecoveryManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    credentials: { ownerSeedHex: ownerSeed, privateStoragePassword },
    phase: 'preflight:wallet-start',
    status: 'pending',
    submissionStarted: false,
    contractAddresses: {},
    receipts: {},
  };
  recovery = record;
  saveRecovery();
  return randomBytes(32).toString('hex');
}

async function main(): Promise<void> {
  assertLoopback();
  if (selectedCase && selectedCase !== 'D-variable' && selectedCase !== 'E-two-coin') {
    throw new Error('SILENCE_LP_CLAIM_CASE only accepts D-variable or E-two-coin for an isolated follow-up run.');
  }
  if (existsSync(recoveryPath)) {
    throw new Error('An unresolved discriminator manifest already exists at ' + recoveryPath + '; refusing duplicate deployments.');
  }
  let ownerSeed = process.env.SILENCE_LOCAL_TEST_SEED?.trim() ?? '';
  delete process.env.SILENCE_LOCAL_TEST_SEED;
  if (!/^(?:[0-9a-fA-F]{2}){16,64}$/.test(ownerSeed)) {
    throw new Error('Set SILENCE_LOCAL_TEST_SEED to a funded, valueless Local Devnet genesis test seed.');
  }
  const proofHealth = await fetch(network.proofServer, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!proofHealth) throw new Error('Proof server is unavailable; runner will not start or reset the stack.');

  setNetworkId(network.networkId);
  const walletSeed = startRecovery(ownerSeed);
  let wallet: WalletContext | undefined;

  try {
    stage('preflight:wallet-start');
    wallet = await createWallet(ownerSeed);
    ownerSeed = '';
    mkdirSync(walletDir, { recursive: true, mode: 0o700 });
    chmodSync(walletDir, 0o700);
    stage('preflight:wallet-sync');
    const state = await wallet.wallet.waitForSyncedState();
    if (state.dust.balance(new Date()) < REQUIRED_DUST_BUFFER) {
      throw new Error('Genesis wallet does not have the fee buffer for all 12 discriminator transactions.');
    }
    const recipient = { bytes: encodeCoinPublicKey(wallet.shieldedSecretKeys.coinPublicKey) };
    assert.equal(recipient.bytes.length, 32, 'Owner recipient must be a 32-byte Compact coin public key.');
    if (process.env.SILENCE_LP_CLAIM_PREFLIGHT_ONLY === '1') {
      process.stdout.write('PASS: loopback and fee preflight succeeded; no chain transaction was submitted.\n');
      safeCleanup = true;
      return;
    }

    const contractModule = await import(pathToFileURL(resolve(artifactsDir, 'contract/index.js')).href) as DynamicModule;
    const compiled = CompiledContract.make('silence-lp-claim-discriminator', contractModule.Contract as never).pipe(
      CompiledContract.withWitnesses({} as never),
      CompiledContract.withCompiledFileAssets(artifactsDir),
    );
    const runtime = await providers(wallet);
    const networkDomain = randomBytes(32);
    const receipts: Record<string, Receipt> = {};
    const allCases = [
      { name: 'A-full', circuit: 'claimFullPayout' },
      { name: 'B-partial-no-write', circuit: 'claimPartialWithoutLedgerWrite' },
      { name: 'C-partial-write', circuit: 'claimPartialWithLedgerWrite' },
      { name: 'D-variable', circuit: 'claimVariablePayout' },
      { name: 'E-two-coin', circuit: 'claimFullWithReserve' },
    ] as const;
    const cases = selectedCase ? allCases.filter((testCase) => testCase.name === selectedCase) : allCases;
    const finalBalances: Record<string, string> = {};
    const observations: Record<string, unknown> = {};

    for (const testCase of cases) {
      stage(testCase.name + ':deploy');
      const deployment = await deploy(runtime, compiled, networkDomain, testCase.name);
      receipts[testCase.name + ':deploy'] = deployment.receipt;

      if (testCase.name === 'E-two-coin') {
        stage(testCase.name + ':mint-reserve');
        const reserveMint = await invoke(runtime, compiled, deployment.address, 'mintTestCoin', [500n, randomBytes(32)], testCase.name + ':mint-reserve');
        receipts[testCase.name + ':mint-reserve'] = reserveMint.receipt;
        const reserve = reserveMint.privateResult as { readonly nonce: Uint8Array; readonly color: Uint8Array; readonly value: bigint };
        assert.equal(reserve.value, 500n);
        stage(testCase.name + ':fund-reserve');
        const reserveFunded = await invoke(runtime, compiled, deployment.address, 'fundReserve', [reserve], testCase.name + ':fund-reserve');
        receipts[testCase.name + ':fund-reserve'] = reserveFunded.receipt;
        const reserveState = await readLedger(runtime.publicDataProvider, contractModule, deployment.address);
        assert.equal(reserveState.reserveFunded, true);
        assert.equal(reserveState.reserveCoin.value, 500n);
        assert.ok(reserveState.reserveCoin.mt_index > 0n);
      }

      stage(testCase.name + ':mint');
      const mint = await invoke(runtime, compiled, deployment.address, 'mintTestCoin', [COLLATERAL, randomBytes(32)], testCase.name + ':mint');
      receipts[testCase.name + ':mint'] = mint.receipt;
      const coin = mint.privateResult as { readonly nonce: Uint8Array; readonly color: Uint8Array; readonly value: bigint };
      assert.equal(coin.value, COLLATERAL);

      stage(testCase.name + ':open');
      const opened = await invoke(runtime, compiled, deployment.address, 'openCollateral', [coin], testCase.name + ':open');
      receipts[testCase.name + ':open'] = opened.receipt;
      const beforeClaim = await readLedger(runtime.publicDataProvider, contractModule, deployment.address);
      assert.equal(beforeClaim.collateralLocked, true);
      assert.equal(beforeClaim.escrowCoin.value, COLLATERAL);
      assert.ok(beforeClaim.escrowCoin.mt_index > 0n);

      stage(testCase.name + ':claim');
      const claimArgs = testCase.name === 'D-variable' ? [PARTIAL_PAYOUT, recipient] : [recipient];
      const claim = await invoke(runtime, compiled, deployment.address, testCase.circuit, claimArgs, testCase.name + ':claim');
      receipts[testCase.name + ':claim'] = claim.receipt;
      const afterClaim = await readLedger(runtime.publicDataProvider, contractModule, deployment.address);
      assert.equal(afterClaim.settled, true);
      finalBalances[testCase.name] = (await shieldedBalance(wallet, Buffer.from(coin.color).toString('hex'))).toString();
      if (testCase.name === 'A-full') {
        assert.equal(afterClaim.changeStored, false);
        observations[testCase.name] = { circuit: testCase.circuit, changeStored: false };
      } else if (testCase.name === 'E-two-coin') {
        assert.equal(afterClaim.changeStored, false);
        assert.equal(afterClaim.reserveFunded, true);
        assert.equal(afterClaim.reserveCoin.value, 500n);
        assert.ok(afterClaim.reserveCoin.mt_index > 0n);
        observations[testCase.name] = {
          circuit: testCase.circuit,
          changeStored: false,
          reserveValue: afterClaim.reserveCoin.value.toString(),
          reserveMtIndex: afterClaim.reserveCoin.mt_index.toString(),
        };
      } else if (testCase.name === 'B-partial-no-write') {
        assert.equal(afterClaim.changeStored, false);
        observations[testCase.name] = { circuit: testCase.circuit, changeStored: false };
      } else {
        assert.equal(afterClaim.changeStored, true);
        assert.equal(afterClaim.changeCoin.value, 200n);
        assert.ok(afterClaim.changeCoin.mt_index > 0n);
        observations[testCase.name] = {
          circuit: testCase.circuit,
          changeStored: true,
          changeValue: afterClaim.changeCoin.value.toString(),
          changeMtIndex: afterClaim.changeCoin.mt_index.toString(),
        };
      }
    }

    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, JSON.stringify({
      checkedAt: new Date().toISOString(),
      mode: selectedCase ? 'one-fresh-loopback-local-devnet-contract-instance' : 'three-fresh-loopback-local-devnet-contract-instances',
      testOnlyValuelessAsset: true,
      results: observations,
      finalShieldedBalances: finalBalances,
      receipts,
      limitations: [
        'Local Devnet only; all collateral is freely minted and valueless.',
        'The A/B/C, D and E evidence files compare full send, partial send, change writeCoin, a public variable-payout branch, and a second funded coin left untouched; this does not model a market or LP solvency.',
        'No raw transaction payloads, proof inputs, seeds, wallet keys, or private state are included.',
      ],
    }, null, 2) + '\n', { mode: 0o600 });
    stage('all-cases-finalized');
    safeCleanup = true;
    process.stdout.write('PASS: ' + cases.length + ' claim circuit(s) finalized and indexed ledger/wallet observations matched.\n');
  } finally {
    ownerSeed = '';
    await wallet?.wallet.stop();
    if (safeCleanup || !submissionStarted) {
      rmSync(recoveryRoot, { recursive: true, force: true });
    } else if (recovery) {
      recovery.status = 'uncertain';
      recovery.phase = activeStage;
      saveRecovery();
      process.stderr.write('Recovery retained at ' + recoveryRoot + '; inspect receipts and contract state before any retry.\n');
    }
    if (previousUmask !== undefined) process.umask(previousUmask);
  }
}

main().catch((error) => {
  process.stderr.write('FAIL stage=' + activeStage + ': ' + safeDiagnostic(error) + '\n');
  if (submissionStarted) process.stderr.write('Chain state may exist; inspect protected recovery at ' + recoveryRoot + ' before retry.\n');
  process.exitCode = 1;
});
