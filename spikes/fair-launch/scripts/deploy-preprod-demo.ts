import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, readdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
import { createSilenceWallet } from '../../../src/chain/wallet.js';
import { fairLaunchMetadataCommitment, validateFairLaunchCreateRequest } from '../../../src/api/fair-launch-create.ts';
import type * as FairLaunch from '../generated/fair_launch/contract/index.js';

Reflect.set(globalThis as object, 'WebSocket', WebSocket);

const INDEXER = 'https://indexer.preprod.midnight.network/api/v4/graphql';
const INDEXER_WS = 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws';
const RPC = 'wss://rpc.preprod.midnight.network';
const PROVER = 'http://127.0.0.1:26300';
const artifactsDir = resolve('spikes/fair-launch/generated/fair_launch');
const recoveryRoot = resolve('.local/fair-launch-preprod-deploy');
const lockPath = resolve(recoveryRoot, 'runner.lock');
const execute = process.argv.includes('--execute');
const commitOption = process.argv.find((item) => item.startsWith('--commit-minutes='));
const commitMinutes = Number(commitOption?.split('=')[1] ?? '60');

type ContractModule = typeof import('../generated/fair_launch/contract/index.js');
type CircuitName = keyof FairLaunch.ImpureCircuits<unknown>;
type CircuitArguments<Name extends CircuitName> = Parameters<FairLaunch.ImpureCircuits<unknown>[Name]> extends [unknown, ...infer Args] ? Args : never;
type DeployArguments = Parameters<InstanceType<ContractModule['Contract']>['initialState']> extends [unknown, ...infer Args] ? Args : never;
type Receipt = { txId: string; transactionHash: string; blockHeight: number; entryPoint: string };
type Coin = { nonceHex: string; colorHex: string; valueAtoms: string };
type Manifest = {
  version: 1; network: 'preprod'; runId: string; createdAt: string;
  status: 'prepared' | 'running' | 'complete' | 'recovery-required';
  stage: string; pending?: { stage: string; txId?: string; startedAt: string };
  metadataCommitmentHex: string; sourceHash: string; contractAddress?: string;
  authoritySecretHex: string; privateStoragePassword: string;
  commitDeadline?: string; openDeadline?: string; saleCoin?: Coin;
  receipts: { deploy?: Receipt; mint?: Receipt; fund?: Receipt };
};

let stage = 'preflight';
let manifest: Manifest | undefined;
let manifestPath = '';

function bytes(hex: string): Uint8Array { return Uint8Array.from(Buffer.from(hex, 'hex')); }

async function saveManifest(): Promise<void> {
  assert.ok(manifestPath && manifest);
  const temporary = `${manifestPath}.tmp-${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, manifestPath);
}

async function checkNetwork(): Promise<void> {
  const response = await fetch('https://rpc.preprod.midnight.network', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'system_chain', params: [], id: 1 }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json() as { result?: unknown };
  assert.equal(body.result, 'Midnight Preprod', 'Remote RPC network identity mismatch.');
  const indexer = await fetch(INDEXER, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'query FairLaunchPreprodHealth { block { height } }' }),
    signal: AbortSignal.timeout(15_000),
  });
  const indexerBody = await indexer.json() as { data?: { block?: { height?: unknown } }; errors?: unknown[] };
  if (!indexer.ok || indexerBody.errors?.length || !Number.isInteger(Number(indexerBody.data?.block?.height))) {
    throw new Error('Preprod indexer health query failed.');
  }
  const prover = await fetch(`${PROVER}/version`, { signal: AbortSignal.timeout(5_000) });
  if (!prover.ok || !(await prover.text()).trim()) throw new Error('Local proof server is unavailable.');
}

async function checkDustRegistration(): Promise<void> {
  const names = (await readdir(resolve('.local'))).filter((name) => /^preprod-dust-registration-attempt-.*\.json$/.test(name));
  let indexed = false;
  for (const name of names) {
    const record = JSON.parse(await readFile(resolve('.local', name), 'utf8')) as { status?: unknown; transactionIdentifier?: unknown };
    if (record.status !== 'indexed') continue;
    if (typeof record.transactionIdentifier !== 'string' || !/^[0-9a-fA-F]{66}$/.test(record.transactionIdentifier)) throw new Error('Indexed DUST registration has no valid identifier.');
    const query = `query CheckDust { transactions(offset: { identifier: "${record.transactionIdentifier}" }) { hash block { height } } }`;
    const response = await fetch(INDEXER, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(15_000) });
    const body = await response.json() as { data?: { transactions?: unknown[] }; errors?: unknown[] };
    if (!response.ok || body.errors?.length || !Array.isArray(body.data?.transactions)) throw new Error('Preprod DUST receipt query failed.');
    if (body.data.transactions.length > 0) indexed = true;
  }
  if (!indexed) throw new Error('No confirmed Preprod DUST registration attempt is recorded.');
}

function witnesses() {
  return {
    quotientRemainder(context: { readonly privateState: unknown }, numerator: bigint, denominator: bigint) {
      return [context.privateState, { quotient: numerator / denominator, remainder: numerator % denominator }];
    },
  };
}

function asCoin(value: unknown): Coin {
  const coin = value as { nonce?: Uint8Array; color?: Uint8Array; value?: bigint } | undefined;
  assert.ok(coin?.nonce instanceof Uint8Array && coin.color instanceof Uint8Array && typeof coin.value === 'bigint');
  return { nonceHex: Buffer.from(coin.nonce).toString('hex'), colorHex: Buffer.from(coin.color).toString('hex'), valueAtoms: coin.value.toString() };
}

async function indexedReceipt(provider: ReturnType<typeof indexerPublicDataProvider>, txId: string, entryPoint: string, address?: string): Promise<Receipt> {
  let receiptTimer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    provider.watchForTxData(txId),
    new Promise<never>((_, reject) => { receiptTimer = setTimeout(() => reject(new Error('Preprod transaction confirmation timeout.')), 600_000); }),
  ]).finally(() => { if (receiptTimer) clearTimeout(receiptTimer); });
  assert.equal(result.status, 'SucceedEntirely', 'Preprod transaction did not succeed entirely.');
  assert.equal(typeof result.blockHeight, 'number');
  assert.match(txId, /^[0-9a-fA-F]{66}$/);
  const query = `query FairLaunchPreprodTx { transactions(offset: { identifier: "${txId}" }) { hash block { height } contractActions { __typename ... on ContractCall { address entryPoint } } } }`;
  const response = await fetch(INDEXER, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json() as { data?: { transactions?: { hash: string; block: { height: number }; contractActions: { __typename?: string; address?: string; entryPoint?: string }[] }[] }; errors?: unknown[] };
  if (!response.ok || body.errors?.length) throw new Error('Preprod receipt hash query failed.');
  const tx = body.data?.transactions?.[0];
  assert.ok(tx && /^[0-9a-fA-F]{64}$/.test(tx.hash) && tx.block.height === result.blockHeight);
  const action = tx.contractActions.find((item) => entryPoint === 'deploy' ? item.__typename === 'ContractDeploy' : item.entryPoint === entryPoint && (!address || item.address === address));
  assert.ok(action, 'Expected contract action is missing from the Preprod receipt.');
  return { txId, transactionHash: tx.hash, blockHeight: result.blockHeight, entryPoint };
}

async function main(): Promise<void> {
  if (process.argv.some((item) => item.startsWith('--') && item !== '--execute' && !item.startsWith('--commit-minutes='))) throw new Error('Unknown option.');
  if (!Number.isSafeInteger(commitMinutes) || commitMinutes < 5 || commitMinutes > 1440) throw new Error('Commit window must be 5–1440 minutes.');
  await checkNetwork();
  await access(resolve(artifactsDir, 'contract/index.js'));
  await access(resolve(artifactsDir, 'keys/registerBid.prover'));
  const input = validateFairLaunchCreateRequest({
    metadata: { name: 'Fair Launch Preprod Test', ticker: 'FLTEST', imageUrl: null, description: 'Valueless four-slot Midnight auction test. No market or liquidity.' },
    config: { inventoryAtoms: '600', reservePriceAtoms: '8', depositLotAtoms: '5000', commitWindowSeconds: commitMinutes * 60, openWindowSeconds: 3600 },
  });
  const domainHex = fairLaunchMetadataCommitment(input);
  const sourceHash = createHash('sha256').update(await readFile(resolve('spikes/fair-launch/contracts/fair_launch.compact'))).digest('hex');
  process.stdout.write(JSON.stringify({ network: 'preprod', mode: execute ? 'execute' : 'preflight', metadataCommitmentHex: domainHex, sourceHash, commitMinutes }) + '\n');
  if (!execute) return;

  await checkDustRegistration();
  const saved = JSON.parse(await readFile(resolve('.local/preprod-dev-wallet.json'), 'utf8')) as { network?: unknown; seedHex?: unknown; unshieldedAddress?: unknown };
  if (saved.network !== 'preprod' || typeof saved.seedHex !== 'string' || !/^(?:[0-9a-fA-F]{2}){16,64}$/.test(saved.seedHex)) throw new Error('Protected Preprod wallet is invalid.');
  const wallet = await createSilenceWallet(saved.seedHex, {
    networkId: 'preprod', indexer: INDEXER, indexerWS: INDEXER_WS, node: RPC, proofServer: PROVER,
  });
  try {
    assert.equal(wallet.accountId, saved.unshieldedAddress, 'Development wallet address mismatch.');
    stage = 'wallet-sync';
    const walletState = await wallet.wallet.waitForSyncedState();
    if (walletState.dust.balance(new Date()) <= 0n) throw new Error('Development wallet has no DUST.');

    await mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
    const runId = randomUUID();
    const runDirectory = resolve(recoveryRoot, runId);
    await writeFile(lockPath, JSON.stringify({ runId, startedAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
    await mkdir(runDirectory, { mode: 0o700 });
    manifestPath = resolve(runDirectory, 'recovery.json');
    manifest = {
      version: 1, network: 'preprod', runId, createdAt: new Date().toISOString(), status: 'prepared', stage: 'prepared',
      metadataCommitmentHex: domainHex, sourceHash, authoritySecretHex: randomBytes(32).toString('hex'),
      privateStoragePassword: randomBytes(32).toString('hex'), receipts: {},
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const provider = indexerPublicDataProvider(INDEXER, INDEXER_WS);
    const zkConfigProvider = new NodeZkConfigProvider(artifactsDir);
    const privateStateProvider = levelPrivateStateProvider({
      accountId: wallet.accountId,
      midnightDbName: resolve(runDirectory, 'midnight-level-db'),
      privateStateStoreName: 'fair-launch-preprod-private-state',
      signingKeyStoreName: 'fair-launch-preprod-signing-keys',
      privateStoragePasswordProvider: () => manifest!.privateStoragePassword,
    });
    const walletProvider = {
      getCoinPublicKey: () => wallet.shieldedSecretKeys.coinPublicKey,
      getEncryptionPublicKey: () => wallet.shieldedSecretKeys.encryptionPublicKey,
      async balanceTx(tx: unknown, ttl?: Date) {
        const recipe = await wallet.wallet.balanceUnboundTransaction(tx as never, {
          shieldedSecretKeys: wallet.shieldedSecretKeys, dustSecretKey: wallet.dustSecretKey,
        }, { ttl: ttl ?? new Date(Date.now() + 30 * 60_000), tokenKindsToBalance: 'all' });
        return wallet.wallet.finalizeRecipe(recipe);
      },
      submitTx: (tx: unknown) => wallet.wallet.submitTransaction(tx as never),
    };
    const providers = {
      privateStateProvider, publicDataProvider: provider, zkConfigProvider,
      proofProvider: httpClientProofProvider(PROVER, zkConfigProvider), walletProvider, midnightProvider: walletProvider,
    };
    const module = await import('../generated/fair_launch/contract/index.js') as ContractModule;
    const compiled = CompiledContract.make('fair-launch', module.Contract as never).pipe(
      CompiledContract.withWitnesses(witnesses() as never),
      CompiledContract.withCompiledFileAssets(artifactsDir),
    );
    const authoritySecret = bytes(manifest.authoritySecretHex);
    const networkDomain = bytes(domainHex);
    const inventory = BigInt(input.config.inventoryAtoms);
    const commitDeadline = BigInt(Math.floor(Date.now() / 1000) + input.config.commitWindowSeconds);
    const openDeadline = commitDeadline + BigInt(input.config.openWindowSeconds);
    manifest.commitDeadline = commitDeadline.toString(); manifest.openDeadline = openDeadline.toString(); await saveManifest();

    async function submit(stageName: 'mint' | 'fund', circuit: CircuitName, address: string, args: readonly unknown[]): Promise<unknown> {
      assert.ok(manifest);
      stage = stageName;
      manifest.status = 'running'; manifest.stage = stageName;
      manifest.pending = { stage: stageName, startedAt: new Date().toISOString() }; await saveManifest();
      const options = createCallTxOptions(compiled as never, circuit as never, address as never, undefined, undefined, [...args] as never);
      const submitted = await submitCallTxAsync(providers as never, options as never);
      manifest.pending.txId = submitted.txId; await saveManifest();
      const receipt = await indexedReceipt(provider, submitted.txId, circuit, address);
      manifest.receipts[stageName] = receipt; manifest.pending = undefined; await saveManifest();
      return (submitted.callTxData as { private?: { result?: unknown } }).private?.result;
    }

    stage = 'deploy';
    manifest.status = 'running'; manifest.stage = 'deploy';
    manifest.pending = { stage: 'deploy', startedAt: new Date().toISOString() }; await saveManifest();
    const deployArgs = [
      networkDomain, inventory, BigInt(input.config.reservePriceAtoms), BigInt(input.config.depositLotAtoms),
      commitDeadline, openDeadline, module.pureCircuits.paymentTestTokenDomain(), module.pureCircuits.saleTestTokenDomain(),
      module.pureCircuits.deriveInventoryAuthorityCommitment(networkDomain, authoritySecret),
      { bytes: encodeCoinPublicKey(wallet.shieldedSecretKeys.coinPublicKey) },
    ] as DeployArguments;
    const deployment = await createUnprovenDeployTx(
      { zkConfigProvider, walletProvider } as never,
      { compiledContract: compiled as never, args: [...deployArgs], signingKey: sampleSigningKey(), initialPrivateState: undefined } as never,
    );
    const address = String(deployment.public.contractAddress);
    assert.match(address, /^[0-9a-fA-F]{64}$/);
    manifest.contractAddress = address; await saveManifest();
    const deployId = await submitTxAsync(providers as never, { unprovenTx: deployment.private.unprovenTx } as never);
    manifest.pending.txId = deployId; await saveManifest();
    manifest.receipts.deploy = await indexedReceipt(provider, deployId, 'deploy', address);
    manifest.pending = undefined; await saveManifest();
    privateStateProvider.setContractAddress(address as never);

    const minted = await submit('mint', 'mintTestSaleCoin', address, [inventory, randomBytes(32), authoritySecret] as CircuitArguments<'mintTestSaleCoin'>);
    manifest.saleCoin = asCoin(minted); await saveManifest();
    const saleCoin = manifest.saleCoin;
    assert.equal(BigInt(saleCoin.valueAtoms), inventory, 'Mint result does not match sale inventory.');
    const fundingCoin = { nonce: bytes(saleCoin.nonceHex), color: bytes(saleCoin.colorHex), value: BigInt(saleCoin.valueAtoms) };
    const afterMint = await wallet.wallet.waitForSyncedState();
    assert.equal(afterMint.shielded.balances[saleCoin.colorHex] ?? 0n, inventory, 'Operator did not receive the minted sale inventory.');
    await submit('fund', 'fundSaleInventory', address, [fundingCoin, authoritySecret] as CircuitArguments<'fundSaleInventory'>);

    const state = await provider.queryContractState(address as never);
    assert.ok(state, 'Preprod contract state is unavailable after funding.');
    const ledgerState = module.ledger(((state as { data?: unknown }).data ?? state) as never);
    assert.equal(ledgerState.saleInventoryFunded, true);
    assert.equal(ledgerState.saleInventoryMinted, true);
    assert.equal(ledgerState.saleInventory, inventory);
    assert.equal(ledgerState.reservePrice, BigInt(input.config.reservePriceAtoms));
    assert.equal(ledgerState.depositLot, BigInt(input.config.depositLotAtoms));
    assert.equal(Buffer.from(ledgerState.networkDomain).toString('hex'), domainHex);
    assert.equal(ledgerState.commitDeadline, commitDeadline);
    assert.equal(ledgerState.openDeadline, openDeadline);
    assert.ok(manifest.receipts.deploy && manifest.receipts.mint && manifest.receipts.fund);
    const afterFund = await wallet.wallet.waitForSyncedState();
    assert.equal(afterFund.shielded.balances[saleCoin.colorHex] ?? 0n, 0n, 'Funded inventory remains in the operator wallet.');
    assert.ok(BigInt(Math.floor(Date.now() / 1000)) + 300n < commitDeadline, 'Funded launch has too little bidding time left.');
    const evidence = {
      network: 'preprod', testAssetsOnly: true, operatorSignedCreate: true,
      metadata: input.metadata, config: input.config, metadataCommitmentHex: domainHex, sourceHash,
      contractAddress: address, commitDeadline: manifest.commitDeadline, openDeadline: manifest.openDeadline,
      readback: { saleInventoryFunded: true, saleInventoryAtoms: String(ledgerState.saleInventory) },
      receipts: manifest.receipts,
    };
    const evidencePath = resolve(runDirectory, 'confirmed-public-evidence.json');
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    manifest.status = 'complete'; manifest.stage = 'complete'; manifest.pending = undefined; await saveManifest();
    await unlink(lockPath);
    process.stdout.write(JSON.stringify({ status: 'verified-preprod-create', contractAddress: address, evidencePath }) + '\n');
  } catch (error) {
    if (manifest) { manifest.status = 'recovery-required'; manifest.stage = stage; await saveManifest(); }
    throw error;
  } finally { await wallet.stop(); }
}

main().catch((error: unknown) => {
  process.stderr.write(`Preprod Fair Launch ${execute ? 'execute' : 'preflight'} stopped at ${stage}: ${error instanceof Error ? error.name : 'UnknownError'}\n`);
  process.exitCode = 1;
});
