import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { filter, firstValueFrom, take, timeout } from 'rxjs';
import * as ledger from '@midnight-ntwrk/midnight-js-protocol/ledger';
import {
  DustWallet, HDWallet, NoOpTransactionHistoryStorage, PublicKey, Roles,
  ShieldedWallet, UnshieldedWallet, WalletFacade, createKeystore,
} from '@midnight-ntwrk/wallet-sdk';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

Reflect.set(globalThis as object, 'WebSocket', WebSocket);

const INDEXER = 'https://indexer.preprod.midnight.network/api/v4/graphql';
const PREPROD_RPC = 'https://rpc.preprod.midnight.network';
const localDirectory = resolve('.local');
const execute = process.argv.includes('--execute');
let stage = 'preflight';

type WalletFile = { readonly network?: unknown; readonly seedHex?: unknown; readonly unshieldedAddress?: unknown };
type Attempt = { status: string; network: string; startedAt: string; priorIds: string[]; selectedCoinCount: number; transactionIdentifier?: string; lastStage?: string };

async function indexerHasTransaction(id: string): Promise<boolean> {
  if (!/^[0-9a-fA-F]{66}$/.test(id)) throw new Error('Unexpected previous transaction identifier.');
  const query = `query CheckRegistration { transactions(offset: { identifier: "${id}" }) { hash block { height } } }`;
  const response = await fetch(INDEXER, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Preprod indexer query failed.');
  const data = await response.json() as { data?: { transactions?: unknown[] }; errors?: unknown[] };
  if (data.errors?.length || !Array.isArray(data.data?.transactions)) throw new Error('Preprod indexer returned an invalid transaction query.');
  return data.data.transactions.length > 0;
}

async function priorIdentifiers(): Promise<string[]> {
  const files = (await readdir(localDirectory)).filter((name) => /^preprod-dust-registration(?:-first-unconfirmed)?\.json$/.test(name));
  const ids = [];
  for (const name of files) {
    const record = JSON.parse(await readFile(resolve(localDirectory, name), 'utf8')) as { transactionIdentifier?: unknown };
    if (typeof record.transactionIdentifier !== 'string') throw new Error('Prior registration record has no transaction identifier.');
    ids.push(record.transactionIdentifier);
  }
  if (ids.length < 2) throw new Error('Expected prior registration records are missing; inspect before retrying.');
  return ids;
}

async function assertPreprodEndpoints(): Promise<void> {
  const response = await fetch(PREPROD_RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'system_chain', params: [], id: 1 }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json() as { result?: unknown };
  if (data.result !== 'Midnight Preprod') throw new Error('RPC did not identify as Midnight Preprod.');
}

async function main(): Promise<void> {
  if (process.argv.some((argument) => argument.startsWith('--') && argument !== '--execute')) throw new Error('Unknown flag.');
  await assertPreprodEndpoints();
  const priorIds = await priorIdentifiers();
  const found = await Promise.all(priorIds.map(indexerHasTransaction));
  if (found.some(Boolean)) throw new Error('A previous registration is indexed; inspect its state instead of submitting again.');
  const existingAttempt = (await readdir(localDirectory)).find((name) => name === 'preprod-dust-register.lock');
  if (existingAttempt) throw new Error('A protected Preprod DUST registration lock exists; inspect it before retrying.');

  const saved = JSON.parse(await readFile(resolve(localDirectory, 'preprod-dev-wallet.json'), 'utf8')) as WalletFile;
  if (saved.network !== 'preprod' || typeof saved.seedHex !== 'string' || !/^(?:[0-9a-fA-F]{2}){16,64}$/.test(saved.seedHex)) {
    throw new Error('Protected development wallet metadata is invalid.');
  }
  const seed = Uint8Array.from(Buffer.from(saved.seedHex, 'hex'));
  const hd = HDWallet.fromSeed(seed);
  seed.fill(0);
  if (hd.type !== 'seedOk') throw new Error('Development wallet could not be derived.');
  const derived = hd.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  hd.hdWallet.clear();
  if (derived.type !== 'keysDerived') throw new Error('Development wallet roles could not be derived.');
  setNetworkId('preprod');
  const shieldedKeys = ledger.ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
  const dustKey = ledger.DustSecretKey.fromSeed(derived.keys[Roles.Dust]);
  const unshielded = createKeystore(derived.keys[Roles.NightExternal], 'preprod');
  if (unshielded.getBech32Address().toString() !== saved.unshieldedAddress) throw new Error('Protected wallet address mismatch.');
  const configuration = {
    networkId: 'preprod' as const,
    indexerClientConnection: {
      indexerHttpUrl: INDEXER,
      indexerWsUrl: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    },
    provingServerUrl: new URL('http://127.0.0.1:26300'),
    relayURL: new URL('wss://rpc.preprod.midnight.network'),
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
  };
  const wallet = await WalletFacade.init({
    configuration,
    shielded: async (config) => ShieldedWallet(config).startWithSecretKeys(shieldedKeys),
    unshielded: async (config) => UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(unshielded)),
    dust: async (config) => DustWallet(config).startWithSecretKey(dustKey, ledger.LedgerParameters.initialParameters().dust),
  });

  let manifestPath: string | undefined;
  let attempt: Attempt | undefined;
  const persist = async () => {
    if (!manifestPath || !attempt) return;
    const temporary = `${manifestPath}.tmp-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(attempt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, manifestPath);
  };
  try {
    stage = 'sync-unshielded';
    await wallet.start(shieldedKeys, dustKey);
    const state = await firstValueFrom(wallet.state().pipe(
      filter((current) => current.unshielded.progress.isStrictlyComplete()),
      take(1), timeout({ first: 120_000 }),
    ));
    const unregistered = state.unshielded.availableCoins.filter((coin) => coin.meta?.registeredForDustGeneration !== true);
    if (unregistered.length !== 1) throw new Error('Expected exactly one unregistered tNIGHT UTXO.');
    stage = 'estimate-registration';
    let lastProgress = 0;
    const progress = wallet.state().subscribe((current) => {
      if (Date.now() - lastProgress < 20_000) return;
      lastProgress = Date.now();
      const dust = current.dust.state.progress;
      process.stdout.write(`SYNC ${JSON.stringify({
        dustApplied: String(dust.appliedIndex),
        dustRelevant: String(dust.highestRelevantWalletIndex),
        dustConnected: dust.isConnected,
        dustComplete: dust.isStrictlyComplete(),
      })}\n`);
    });
    let estimateTimer: ReturnType<typeof setTimeout> | undefined;
    let fee: bigint;
    try {
      ({ fee } = await Promise.race([
        wallet.estimateRegistration(unregistered),
        new Promise<never>((_, reject) => { estimateTimer = setTimeout(() => reject(new Error('DUST sync did not permit fee estimation within two hours.')), 7_200_000); }),
      ]));
    } finally { progress.unsubscribe(); if (estimateTimer) clearTimeout(estimateTimer); }
    process.stdout.write(JSON.stringify({ network: 'preprod', mode: execute ? 'execute' : 'preflight', priorIdsAbsent: true, unregisteredCoinCount: unregistered.length, estimatedFeeSpeck: String(fee), fullWalletSyncComplete: state.isSynced }) + '\n');
    if (!execute) return;

    attempt = { status: 'prepared', network: 'preprod', startedAt: new Date().toISOString(), priorIds, selectedCoinCount: unregistered.length };
    manifestPath = resolve(localDirectory, `preprod-dust-registration-attempt-${randomUUID()}.json`);
    await writeFile(resolve(localDirectory, 'preprod-dust-register.lock'), JSON.stringify({ manifestPath, startedAt: attempt.startedAt }) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile(manifestPath, JSON.stringify(attempt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

    stage = 'wait-for-registration-fee';
    attempt.lastStage = stage; await persist();
    await wallet.waitForGeneratedDust(unregistered, fee, { timeoutMs: 300_000 });
    stage = 'build-registration';
    attempt.lastStage = stage; await persist();
    const recipe = await wallet.registerNightUtxosForDustGeneration(
      unregistered, unshielded.getPublicKey(), (payload) => unshielded.signData(payload),
    );
    stage = 'prove-and-finalize-registration';
    attempt.lastStage = stage; await persist();
    const transaction = await wallet.finalizeRecipe(recipe);
    const id = transaction.identifiers()[0];
    if (!id || !/^[0-9a-fA-F]{66}$/.test(id)) throw new Error('Unexpected registration transaction identifier.');
    attempt.transactionIdentifier = id;
    attempt.status = 'submission-unconfirmed';
    stage = 'submit-registration';
    attempt.lastStage = stage; await persist();
    await wallet.submitTransaction(transaction);
    attempt.status = 'submitted-awaiting-indexer';
    attempt.lastStage = 'poll-indexer'; await persist();
    const provider = indexerPublicDataProvider(INDEXER, 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws');
    let receiptTimer: ReturnType<typeof setTimeout> | undefined;
    const receipt = await Promise.race([
      provider.watchForTxData(id),
      new Promise<never>((_, reject) => { receiptTimer = setTimeout(() => reject(new Error('Registration receipt timeout.')), 120_000); }),
    ]).finally(() => { if (receiptTimer) clearTimeout(receiptTimer); });
    if (receipt.status !== 'SucceedEntirely' || typeof receipt.blockHeight !== 'number') throw new Error('Registration did not fully succeed.');
    attempt.status = 'indexed'; await persist();
    process.stdout.write(JSON.stringify({ status: 'indexed', transactionIdentifier: id, blockHeight: receipt.blockHeight }) + '\n');
  } catch (error) {
    if (attempt) { attempt.status = attempt.transactionIdentifier ? 'submission-unconfirmed' : 'recovery-required'; attempt.lastStage = stage; await persist(); }
    throw error;
  } finally { await wallet.stop(); }
}

main().catch((error: unknown) => {
  process.stderr.write(`Preprod DUST ${execute ? 'execute' : 'preflight'} stopped at ${stage}: ${error instanceof Error ? error.name : 'UnknownError'}\n`);
  process.exitCode = 1;
});
