import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readdirSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import {
  createCallTxOptions, createUnprovenDeployTx, submitCallTxAsync, submitTxAsync,
} from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { encodeCoinPublicKey, sampleSigningKey } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import type * as FairLaunch from '../generated/fair_launch/contract/index.js';
import { localTestNetwork } from '../../../src/chain/client.js';
import { createSilenceWallet } from '../../../src/chain/wallet.js';
import {
  appendFairLaunchCatalogEntry, assertLocalDevnetEndpoints, fairLaunchMetadataCommitment,
  localDevnetEndpoints, validateFairLaunchCreateRequest,
  type FairLaunchCreateRequest, type FairLaunchEntry, type FairLaunchReceiptRef,
} from '../../../src/api/fair-launch-create.ts';
import { createExclusiveRunnerLock } from './runner-lock.ts';
import { sanitizeRunnerDiagnostic } from './runner-diagnostic.ts';

Reflect.set(globalThis as object, 'WebSocket', WebSocket);

const spikeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = resolve(spikeDir, '../..');
const artifactsDir = resolve(spikeDir, 'generated/fair_launch');
const recoveryRoot = resolve(projectDir, '.local/fair-launch-create-recovery');
const lockPath = join(recoveryRoot, 'runner.lock');

type ContractModule = typeof import('../generated/fair_launch/contract/index.js');
type DeployArguments = Parameters<InstanceType<ContractModule['Contract']>['initialState']> extends [unknown, ...infer Args]
  ? Args
  : never;
type CircuitName = keyof FairLaunch.ImpureCircuits<unknown>;
type CircuitArguments<Name extends CircuitName> =
  Parameters<FairLaunch.ImpureCircuits<unknown>[Name]> extends [unknown, ...infer Args] ? Args : never;
type WalletContext = Awaited<ReturnType<typeof createSilenceWallet>>;
type CoinRecord = { readonly nonceHex: string; readonly colorHex: string; readonly valueAtoms: string };
type ActionReceipt = FairLaunchReceiptRef & {
  readonly status: 'SucceedEntirely';
  readonly entryPoint: string;
  readonly durationMs: number;
};
type FinalizedReceipt = { readonly txId: string; readonly blockHeight: number };
type PendingAction = { readonly stage: string; readonly phase: 'building' | 'submitted'; readonly txId?: string; readonly startedAt: string };
type CreateManifest = {
  readonly version: 1;
  readonly operationId: string;
  readonly createdAt: string;
  status: 'prepared' | 'running' | 'complete' | 'recovery-required';
  readonly operatorSeedHex: string;
  readonly privateStoragePassword: string;
  readonly authoritySecretHex: string;
  readonly input: FairLaunchCreateRequest;
  readonly networkDomainHex: string;
  readonly metadataCommitmentHex: string;
  commitDeadlineUnixSeconds?: string;
  openDeadlineUnixSeconds?: string;
  actions: { deploy?: ActionReceipt; mint?: ActionReceipt; fund?: ActionReceipt };
  pending?: PendingAction;
  contractAddress?: string;
  saleCoin?: CoinRecord;
  failureStage?: string;
};
type TransactionRecord = {
  readonly hash: string;
  readonly raw: string;
  readonly block: { readonly height: number };
  readonly contractActions: readonly { readonly __typename?: string; readonly address?: string; readonly entryPoint?: string }[];
};

class CreateRunnerError extends Error {}

let lockOwned = false;
let preserveLock = false;
let manifest: CreateManifest | undefined;
let manifestPath = '';
let runDirectory = '';
let activeStage = 'preflight';

function bytes(hex: string): Uint8Array { return Uint8Array.from(Buffer.from(hex, 'hex')); }

function ensurePrivateDirectory(path: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false, 'Refusing a symlink in protected create recovery.');
    assert.equal(stat.isDirectory(), true, 'Fair Launch recovery path is not a directory.');
  } else mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function secureTree(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  assert.equal(stat.isSymbolicLink(), false, 'Refusing a symlink in protected create recovery.');
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) secureTree(join(path, name));
  } else chmodSync(path, 0o600);
}

function persist(document: CreateManifest): void {
  ensurePrivateDirectory(recoveryRoot);
  ensurePrivateDirectory(runDirectory);
  const temporary = `${manifestPath}.tmp-${process.pid}`;
  assert.equal(existsSync(temporary), false, 'Create recovery temp file exists; stop for manual reconciliation.');
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  chmodSync(temporary, 0o600);
  renameSync(temporary, manifestPath);
  chmodSync(manifestPath, 0o600);
  const directory = openSync(runDirectory, 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
  secureTree(runDirectory);
}

function acquireLock(operationId: string): void {
  ensurePrivateDirectory(resolve(projectDir, '.local'));
  ensurePrivateDirectory(recoveryRoot);
  createExclusiveRunnerLock(lockPath, `${JSON.stringify({ operationId, pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  lockOwned = true;
  chmodSync(lockPath, 0o600);
  assert.equal(lstatSync(lockPath).isSymbolicLink(), false, 'Create runner lock cannot be a symlink.');
  assert.equal(lstatSync(lockPath).mode & 0o777, 0o600, 'Create runner lock must be mode 0600.');
}

function releaseOwnLock(): void {
  if (!lockOwned) return;
  const stat = lstatSync(lockPath);
  assert.equal(stat.isSymbolicLink(), false, 'Refusing to remove a replaced create runner lock symlink.');
  assert.equal(stat.isFile(), true, 'Refusing to remove a non-file create runner lock.');
  unlinkSync(lockPath);
  lockOwned = false;
}

function discardUnsubmittedRecovery(): void {
  if (!runDirectory || !existsSync(runDirectory) || manifest?.pending || manifest?.actions.deploy || manifest?.actions.mint || manifest?.actions.fund) return;
  secureTree(runDirectory);
  rmSync(runDirectory, { recursive: true });
  runDirectory = '';
  manifestPath = '';
  manifest = undefined;
}

function readStdinJson(): Promise<unknown> {
  return new Promise((resolveInput, rejectInput) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      input += chunk;
      if (Buffer.byteLength(input) > 12 * 1024) {
        process.stdin.destroy();
        rejectInput(new CreateRunnerError('Create request is too large.'));
      }
    });
    process.stdin.once('end', () => {
      try { resolveInput(JSON.parse(input) as unknown); }
      catch { rejectInput(new CreateRunnerError('Create request is not valid JSON.')); }
    });
    process.stdin.once('error', () => rejectInput(new CreateRunnerError('Create request could not be read.')));
  });
}

function parseInvocation(value: unknown): { operationId: string; input: FairLaunchCreateRequest } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CreateRunnerError('Create request is invalid.');
  const candidate = value as { operationId?: unknown; input?: unknown };
  if (typeof candidate.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.operationId)) {
    throw new CreateRunnerError('Create operation ID is invalid.');
  }
  return { operationId: candidate.operationId, input: validateFairLaunchCreateRequest(candidate.input) };
}

function assertLocalOnly(): void {
  if (process.env.FAIR_LAUNCH_CREATE_ENABLED !== '1') throw new CreateRunnerError('Local Devnet Create is not enabled.');
  assertLocalDevnetEndpoints(localDevnetEndpoints());
}

function witnesses() {
  return {
    quotientRemainder(context: { readonly privateState: unknown }, numerator: bigint, denominator: bigint) {
      return [context.privateState, { quotient: numerator / denominator, remainder: numerator % denominator }];
    },
  };
}

function makeNetwork(password: string) {
  const network = localTestNetwork(password);
  return {
    ...network,
    artifactsDir,
    privateStateDir: join(runDirectory, 'wallet-private-state'),
  };
}

function createProviders(wallet: WalletContext, password: string, network: ReturnType<typeof makeNetwork>) {
  const publicDataProvider = indexerPublicDataProvider(network.indexer, network.indexerWS);
  const zkConfigProvider = new NodeZkConfigProvider(artifactsDir);
  const walletProvider = {
    getCoinPublicKey: () => wallet.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => wallet.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: unknown, ttl?: Date) {
      const recipe = await wallet.wallet.balanceUnboundTransaction(
        tx as never,
        { shieldedSecretKeys: wallet.shieldedSecretKeys, dustSecretKey: wallet.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000), tokenKindsToBalance: 'all' },
      );
      return wallet.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: unknown) => wallet.wallet.submitTransaction(tx as never),
  };
  const privateStateProvider = levelPrivateStateProvider({
    accountId: wallet.accountId,
    midnightDbName: join(runDirectory, 'midnight-level-db'),
    privateStateStoreName: 'fair-launch-create-private-state',
    signingKeyStoreName: 'fair-launch-create-signing-keys',
    privateStoragePasswordProvider: () => password,
  });
  const providers = {
    privateStateProvider,
    publicDataProvider,
    zkConfigProvider,
    proofProvider: httpClientProofProvider(network.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
  return { providers, publicDataProvider, walletProvider, privateStateProvider };
}

async function waitForFinalized(provider: ReturnType<typeof indexerPublicDataProvider>, txId: string): Promise<FinalizedReceipt> {
  const result = await provider.watchForTxData(txId);
  assert.equal(result.status, 'SucceedEntirely', 'Transaction did not finalize successfully.');
  assert.equal(typeof result.blockHeight, 'number');
  return { txId, blockHeight: result.blockHeight! };
}

async function readIndexedTransaction(txId: string, blockHeight: number): Promise<TransactionRecord> {
  const identifier = txId.replace(/^0x/i, '');
  assert.match(identifier, /^[0-9a-fA-F]{66}$/, 'Unexpected transaction identifier format.');
  const query = 'query FairLaunchCreateTransaction { transactions(offset: { identifier: ' + JSON.stringify(identifier) +
    ' }) { hash raw block { height } contractActions { __typename ... on ContractCall { address entryPoint } } } }';
  const response = await fetch(localDevnetEndpoints().indexer, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new CreateRunnerError('Local indexer transaction read failed.');
  const body = await response.json() as { readonly data?: { readonly transactions?: readonly TransactionRecord[] }; readonly errors?: readonly unknown[] };
  if (body.errors?.length) throw new CreateRunnerError('Local indexer rejected the transaction query.');
  const transaction = body.data?.transactions?.[0];
  assert.ok(transaction && typeof transaction.raw === 'string', 'Indexed transaction details are unavailable.');
  assert.equal(transaction.block.height, blockHeight, 'Receipt and indexer block heights differ.');
  assert.match(transaction.hash, /^[0-9a-fA-F]{64}$/, 'Unexpected transaction hash format.');
  return transaction;
}

async function verifiedReceipt(
  provider: ReturnType<typeof indexerPublicDataProvider>,
  txId: string,
  entryPoint: string,
  contractAddress?: string,
): Promise<ActionReceipt> {
  const receipt = await waitForFinalized(provider, txId);
  const transaction = await readIndexedTransaction(receipt.txId, receipt.blockHeight);
  if (entryPoint === 'deploy') {
    const deploymentAction = transaction.contractActions.find((action) => action.__typename === 'ContractDeploy');
    assert.ok(deploymentAction, 'Indexer does not show the deploy action.');
  } else {
    const action = transaction.contractActions.find((candidate) => candidate.entryPoint === entryPoint);
    assert.ok(action, `Indexer does not show the ${entryPoint} circuit.`);
    if (action.address) assert.equal(action.address, contractAddress);
  }
  return {
    ...receipt,
    transactionHash: transaction.hash,
    status: 'SucceedEntirely',
    entryPoint,
    durationMs: 0,
  } as ActionReceipt;
}

function persistBeforeAction(stage: string): void {
  assert.ok(manifest);
  assert.equal(manifest.pending, undefined, 'Prior action is unresolved; stop for manual reconciliation.');
  activeStage = stage;
  manifest.status = 'running';
  manifest.pending = { stage, phase: 'building', startedAt: new Date().toISOString() };
  persist(manifest);
}

async function deploy(
  providerSet: ReturnType<typeof createProviders>,
  module: ContractModule,
  compiled: unknown,
  args: DeployArguments,
): Promise<string> {
  persistBeforeAction('deploy');
  const deployment = await createUnprovenDeployTx(
    { zkConfigProvider: providerSet.providers.zkConfigProvider, walletProvider: providerSet.walletProvider } as never,
    { compiledContract: compiled as never, args: [...args], signingKey: sampleSigningKey(), initialPrivateState: undefined } as never,
  );
  const address = String(deployment.public.contractAddress);
  assert.match(address, /^[0-9a-fA-F]{64}$/, 'Deployment returned an invalid contract address.');
  assert.ok(manifest);
  manifest.contractAddress = address;
  manifest.pending = { ...manifest.pending!, phase: 'building' };
  persist(manifest);
  const txId = await submitTxAsync(providerSet.providers as never, { unprovenTx: deployment.private.unprovenTx } as never);
  manifest.pending = { ...manifest.pending!, phase: 'submitted', txId };
  persist(manifest);
  const receipt = await verifiedReceipt(providerSet.publicDataProvider, txId, 'deploy', address);
  manifest.actions = { ...manifest.actions, deploy: receipt };
  manifest.pending = undefined;
  persist(manifest);
  const state = await providerSet.publicDataProvider.queryContractState(address as never);
  assert.ok(state, 'Deployed contract is missing from the Local Devnet indexer.');
  return address;
}

async function call<Name extends CircuitName>(
  stage: 'mint' | 'fund',
  circuit: Name,
  providerSet: ReturnType<typeof createProviders>,
  compiled: unknown,
  address: string,
  args: CircuitArguments<Name>,
): Promise<unknown> {
  persistBeforeAction(stage);
  const options = createCallTxOptions(compiled as never, circuit as never, address as never, undefined, undefined, [...args] as never);
  const submitted = await submitCallTxAsync(providerSet.providers as never, options as never);
  assert.ok(manifest);
  manifest.pending = { ...manifest.pending!, phase: 'submitted', txId: submitted.txId };
  persist(manifest);
  const receipt = await verifiedReceipt(providerSet.publicDataProvider, submitted.txId, circuit, address);
  manifest.actions = { ...manifest.actions, [stage]: receipt };
  manifest.pending = undefined;
  persist(manifest);
  return (submitted.callTxData as { readonly private?: { readonly result?: unknown } }).private?.result;
}

function asCoin(value: unknown): CoinRecord {
  const coin = value as { readonly nonce?: Uint8Array; readonly color?: Uint8Array; readonly value?: bigint } | undefined;
  assert.ok(coin?.nonce instanceof Uint8Array && coin.color instanceof Uint8Array && typeof coin.value === 'bigint', 'Sale mint produced no shielded coin.');
  return { nonceHex: Buffer.from(coin.nonce).toString('hex'), colorHex: Buffer.from(coin.color).toString('hex'), valueAtoms: coin.value.toString() };
}

async function readLedger(provider: ReturnType<typeof indexerPublicDataProvider>, module: ContractModule, address: string) {
  const state = await provider.queryContractState(address as never);
  assert.ok(state, 'Contract ledger is unavailable from the Local Devnet indexer.');
  return module.ledger(((state as { readonly data?: unknown }).data ?? state) as never);
}

function makeEntry(
  input: FairLaunchCreateRequest,
  address: string,
  metadataCommitmentHex: string,
  receipts: { deploy: ActionReceipt; mint: ActionReceipt; fund: ActionReceipt },
  commitDeadlineUnixSeconds: string,
  openDeadlineUnixSeconds: string,
): FairLaunchEntry {
  return {
    id: address,
    contractAddress: address,
    metadata: input.metadata,
    config: input.config,
    phase: 'commit',
    createdAt: new Date().toISOString(),
    commitDeadlineUnixSeconds,
    openDeadlineUnixSeconds,
    metadataAnchored: true,
    metadataCommitmentHex,
    artworkBytesAnchored: false,
    evidenceSource: 'verified-local-devnet-create',
    receipts: {
      deploy: { txId: receipts.deploy.txId, transactionHash: receipts.deploy.transactionHash, blockHeight: receipts.deploy.blockHeight },
      mint: { txId: receipts.mint.txId, transactionHash: receipts.mint.transactionHash, blockHeight: receipts.mint.blockHeight },
      fund: { txId: receipts.fund.txId, transactionHash: receipts.fund.transactionHash, blockHeight: receipts.fund.blockHeight },
    },
  };
}

async function execute(input: FairLaunchCreateRequest, operationId: string): Promise<FairLaunchEntry> {
  const seed = process.env.FAIR_LAUNCH_LOCAL_TEST_SEED?.trim() ?? '';
  delete process.env.FAIR_LAUNCH_LOCAL_TEST_SEED;
  if (!/^(?:[0-9a-fA-F]{2}){32}$/.test(seed)) throw new CreateRunnerError('A 32-byte Local Devnet operator test seed is required.');
  const privateStoragePassword = randomBytes(32).toString('hex');
  const metadataCommitmentHex = fairLaunchMetadataCommitment(input);
  runDirectory = join(recoveryRoot, operationId);
  manifestPath = join(runDirectory, 'recovery.json');
  if (existsSync(runDirectory)) throw new CreateRunnerError('Operation recovery already exists; no retry is safe.');
  ensurePrivateDirectory(runDirectory);
  manifest = {
    version: 1,
    operationId,
    createdAt: new Date().toISOString(),
    status: 'prepared',
    operatorSeedHex: seed,
    privateStoragePassword,
    authoritySecretHex: randomBytes(32).toString('hex'),
    input,
    networkDomainHex: metadataCommitmentHex,
    metadataCommitmentHex,
    actions: {},
  };
  persist(manifest);

  const endpoints = localDevnetEndpoints();
  assertLocalDevnetEndpoints(endpoints);
  const network = makeNetwork(privateStoragePassword);
  const proofReady = await fetch(network.proofServer, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
  const indexerReady = await fetch(network.indexer, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'query FairLaunchHealth { __typename }' }), signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (!proofReady || !indexerReady?.ok) throw new CreateRunnerError('Loopback Local Devnet proof/indexer endpoint unavailable.');

  const wallet = await createSilenceWallet(seed, network);
  try {
    const walletState = await wallet.wallet.waitForSyncedState();
    const operatorDust = walletState.dust.balance(new Date());
    if (operatorDust <= 0n) throw new CreateRunnerError('Local Devnet operator wallet has no DUST for transaction fees.');
    const providerSet = createProviders(wallet, privateStoragePassword, network);
    const module = await import(pathToFileURL(resolve(artifactsDir, 'contract/index.js')).href) as ContractModule;
    const compiled = CompiledContract.make('fair-launch', module.Contract as never).pipe(
      CompiledContract.withWitnesses(witnesses() as never),
      CompiledContract.withCompiledFileAssets(artifactsDir),
    );
    const inventory = BigInt(input.config.inventoryAtoms);
    const reservePrice = BigInt(input.config.reservePriceAtoms);
    const depositLot = BigInt(input.config.depositLotAtoms);
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    const commitDeadline = nowSeconds + BigInt(input.config.commitWindowSeconds);
    const openDeadline = commitDeadline + BigInt(input.config.openWindowSeconds);
    if (openDeadline > 4_000_000_000n) throw new CreateRunnerError('Auction end time exceeds the Compact contract limit.');
    assert.ok(manifest);
    manifest.commitDeadlineUnixSeconds = commitDeadline.toString();
    manifest.openDeadlineUnixSeconds = openDeadline.toString();
    persist(manifest);
    const networkDomain = bytes(metadataCommitmentHex);
    const paymentDomain = module.pureCircuits.paymentTestTokenDomain();
    const saleDomain = module.pureCircuits.saleTestTokenDomain();
    const authoritySecret = bytes(manifest.authoritySecretHex);
    const authorityCommitment = module.pureCircuits.deriveInventoryAuthorityCommitment(networkDomain, authoritySecret);
    const deployment = await deploy(providerSet, module, compiled, [
      networkDomain,
      inventory,
      reservePrice,
      depositLot,
      commitDeadline,
      openDeadline,
      paymentDomain,
      saleDomain,
      authorityCommitment,
      { bytes: encodeCoinPublicKey(wallet.shieldedSecretKeys.coinPublicKey) },
    ] as DeployArguments);
    const address = deployment;
    const saleMintResult = await call('mint', 'mintTestSaleCoin', providerSet, compiled, address,
      [inventory, bytes(randomBytes(32).toString('hex')), authoritySecret] as CircuitArguments<'mintTestSaleCoin'>);
    const saleCoin = asCoin(saleMintResult);
    assert.equal(BigInt(saleCoin.valueAtoms), inventory, 'Minted sale token amount does not match inventory.');
    manifest.saleCoin = saleCoin;
    persist(manifest);
    await wallet.wallet.waitForSyncedState();
    const saleBalance = (await wallet.wallet.waitForSyncedState()).shielded.balances[saleCoin.colorHex] ?? 0n;
    assert.equal(saleBalance, inventory, 'Operator wallet cannot read back the minted sale inventory.');
    const beforeFund = await readLedger(providerSet.publicDataProvider, module, address);
    assert.equal(beforeFund.saleInventoryMinted, true, 'Finalized mint receipt did not update the contract ledger.');
    assert.equal(beforeFund.saleInventoryFunded, false, 'Sale inventory was unexpectedly funded before the funding call.');
    assert.equal(beforeFund.saleInventory, inventory);
    assert.deepEqual(Buffer.from(beforeFund.networkDomain).toString('hex'), metadataCommitmentHex);

    await call('fund', 'fundSaleInventory', providerSet, compiled, address, [
      { nonce: bytes(saleCoin.nonceHex), color: bytes(saleCoin.colorHex), value: BigInt(saleCoin.valueAtoms) },
      authoritySecret,
    ] as CircuitArguments<'fundSaleInventory'>);
    const afterFund = await readLedger(providerSet.publicDataProvider, module, address);
    assert.equal(afterFund.saleInventoryFunded, true, 'Finalized funding receipt did not update the contract ledger.');
    assert.equal(afterFund.saleInventoryMinted, true);
    assert.equal(afterFund.saleInventory, inventory);
    assert.equal(afterFund.reservePrice, reservePrice);
    assert.equal(afterFund.depositLot, depositLot);
    assert.equal(afterFund.commitDeadline, commitDeadline);
    assert.equal(afterFund.openDeadline, openDeadline);
    assert.equal(Buffer.from(afterFund.networkDomain).toString('hex'), metadataCommitmentHex,
      'On-chain metadata/config commitment differs from the requested launch.');
    assert.equal(Buffer.from(afterFund.paymentTokenDomain).toString('hex'), Buffer.from(paymentDomain).toString('hex'));
    assert.equal(Buffer.from(afterFund.saleTokenDomain).toString('hex'), Buffer.from(saleDomain).toString('hex'));
    const finalWalletState = await wallet.wallet.waitForSyncedState();
    assert.equal(finalWalletState.shielded.balances[saleCoin.colorHex] ?? 0n, 0n,
      'Funded sale inventory did not leave the operator wallet.');
    if (BigInt(Math.floor(Date.now() / 1000)) + 60n >= commitDeadline) {
      throw new CreateRunnerError('Commit window is too close to closing after funding; launch was not listed.');
    }

    assert.ok(manifest.actions.deploy && manifest.actions.mint && manifest.actions.fund,
      'All three finalized transaction receipts are required.');
    const entry = makeEntry(input, address, metadataCommitmentHex, {
      deploy: manifest.actions.deploy,
      mint: manifest.actions.mint,
      fund: manifest.actions.fund,
    }, commitDeadline.toString(), openDeadline.toString());
    await appendFairLaunchCatalogEntry(entry);
    const recorded = await (await import('../../../src/api/fair-launch-create.ts')).readFairLaunchCatalog();
    assert.ok(recorded.some((candidate) => candidate.contractAddress === address), 'Catalog did not read back the verified launch.');
    manifest.status = 'complete';
    manifest.pending = undefined;
    delete (manifest as { operatorSeedHex?: string }).operatorSeedHex;
    delete (manifest as { privateStoragePassword?: string }).privateStoragePassword;
    delete (manifest as { authoritySecretHex?: string }).authoritySecretHex;
    persist(manifest);
    return entry;
  } finally {
    await wallet.stop();
  }
}

async function main(): Promise<void> {
  let operationId: string = randomUUID();
  try {
    assertLocalOnly();
    const invocation = parseInvocation(await readStdinJson());
    operationId = invocation.operationId;
    acquireLock(operationId);
    const existingDirectory = join(recoveryRoot, operationId);
    if (existsSync(existingDirectory)) throw new CreateRunnerError('Operation recovery already exists; no retry is safe.');
    try {
      const entry = await execute(invocation.input, operationId);
      process.stdout.write(`${JSON.stringify({ status: 'confirmed', operationId, launch: entry })}\n`);
    } catch (error) {
      const started = Boolean(manifest?.pending || manifest?.actions.deploy || manifest?.actions.mint || manifest?.actions.fund);
      if (started) {
        preserveLock = true;
        if (manifest) {
          manifest.status = 'recovery-required';
          manifest.failureStage = activeStage;
          persist(manifest);
        }
        process.stdout.write(`${JSON.stringify({
          status: 'recovery-required',
          operationId,
          message: 'Local Devnet activity may have been submitted. Inspect protected recovery before any retry.',
        })}\n`);
        process.exitCode = 2;
        return;
      }
      discardUnsubmittedRecovery();
      throw error;
    }
  } catch (error) {
    const safeMessage = sanitizeRunnerDiagnostic(error);
    process.stdout.write(`${JSON.stringify({ status: 'rejected', operationId, message: safeMessage })}\n`);
    process.exitCode = 1;
  } finally {
    if (!preserveLock) releaseOwnLock();
    if (runDirectory && existsSync(runDirectory)) secureTree(runDirectory);
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && pathToFileURL(resolve(entry)).href === import.meta.url);
}

if (isDirectExecution()) void main();
