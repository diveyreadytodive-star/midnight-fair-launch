import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import * as ledger from '@midnight-ntwrk/midnight-js-protocol/ledger';
import {
  DustWallet, HDWallet, NoOpTransactionHistoryStorage, PublicKey, Roles,
  ShieldedWallet, UnshieldedWallet, WalletFacade, createKeystore,
} from '@midnight-ntwrk/wallet-sdk';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

Reflect.set(globalThis as object, 'WebSocket', WebSocket);

type DevelopmentWalletFile = {
  readonly network?: unknown;
  readonly seedHex?: unknown;
  readonly unshieldedAddress?: unknown;
};

let stage = 'read-protected-file';

async function main(): Promise<void> {
  const file = resolve('.local/preprod-dev-wallet.json');
  const saved = JSON.parse(await readFile(file, 'utf8')) as DevelopmentWalletFile;
  if (saved.network !== 'preprod' || typeof saved.seedHex !== 'string' || !/^(?:[0-9a-fA-F]{2}){16,64}$/.test(saved.seedHex)) {
    throw new Error('Protected Preprod development wallet metadata is invalid.');
  }
  const rawSeed = Uint8Array.from(Buffer.from(saved.seedHex, 'hex'));
  stage = 'derive-wallet';
  const hd = HDWallet.fromSeed(rawSeed);
  rawSeed.fill(0);
  if (hd.type !== 'seedOk') throw new Error('Development wallet seed could not be derived.');
  const derived = hd.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  hd.hdWallet.clear();
  if (derived.type !== 'keysDerived') throw new Error('Development wallet roles could not be derived.');

  setNetworkId('preprod');
  const shieldedKeys = ledger.ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
  const dustKey = ledger.DustSecretKey.fromSeed(derived.keys[Roles.Dust]);
  const unshielded = createKeystore(derived.keys[Roles.NightExternal], 'preprod');
  const address = unshielded.getBech32Address().toString();
  stage = 'check-address';
  if (address !== saved.unshieldedAddress) throw new Error('Derived wallet address does not match the protected file.');

  const configuration = {
    networkId: 'preprod' as const,
    indexerClientConnection: {
      indexerHttpUrl: 'https://indexer.preprod.midnight.network/api/v4/graphql',
      indexerWsUrl: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    },
    provingServerUrl: new URL('http://127.0.0.1:26300'),
    relayURL: new URL('wss://rpc.preprod.midnight.network'),
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
  };
  stage = 'initialize-wallet';
  const wallet = await WalletFacade.init({
    configuration,
    shielded: async (config) => ShieldedWallet(config).startWithSecretKeys(shieldedKeys),
    unshielded: async (config) => UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(unshielded)),
    dust: async (config) => DustWallet(config).startWithSecretKey(dustKey, ledger.LedgerParameters.initialParameters().dust),
  });
  try {
    stage = 'start-wallet';
    await wallet.start(shieldedKeys, dustKey);
    stage = 'sync-wallet';
    let lastProgress = 0;
    let latest: Awaited<ReturnType<typeof wallet.waitForSyncedState>> | undefined;
    const progress = wallet.state().subscribe((current) => {
      latest = current;
      if (Date.now() - lastProgress < 15_000) return;
      lastProgress = Date.now();
      const unshieldedProgress = current.unshielded.progress;
      const shieldedProgress = current.shielded.state.progress;
      const dustProgress = current.dust.state.progress;
      process.stdout.write(`SYNC ${JSON.stringify({
        complete: current.isSynced,
        unshieldedApplied: String(unshieldedProgress.appliedId),
        unshieldedHighest: String(unshieldedProgress.highestTransactionId),
        unshieldedConnected: unshieldedProgress.isConnected,
        shieldedApplied: String(shieldedProgress.appliedIndex),
        shieldedRelevant: String(shieldedProgress.highestRelevantWalletIndex),
        shieldedHighest: String(shieldedProgress.highestIndex),
        shieldedConnected: shieldedProgress.isConnected,
        dustApplied: String(dustProgress.appliedIndex),
        dustRelevant: String(dustProgress.highestRelevantWalletIndex),
        dustHighest: String(dustProgress.highestIndex),
        dustConnected: dustProgress.isConnected,
      })}\n`);
    });
    let synced = true;
    let state;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      state = await Promise.race([
        wallet.waitForSyncedState(),
        new Promise<Awaited<ReturnType<typeof wallet.waitForSyncedState>>>((resolve, reject) => { timeoutHandle = setTimeout(() => {
          if (latest) { synced = false; resolve(latest); }
          else reject(new Error('Preprod wallet did not report any state within 120 seconds.'));
        }, 120_000); }),
      ]);
    } finally { progress.unsubscribe(); if (timeoutHandle) clearTimeout(timeoutHandle); }
    const unregistered = state.unshielded.availableCoins.filter((coin) => coin.meta?.registeredForDustGeneration !== true);
    const dustBalance = state.dust.balance(new Date());
    process.stdout.write(JSON.stringify({
      network: 'preprod',
      addressMatchesProtectedFile: true,
      fullWalletSyncComplete: synced && state.isSynced,
      unshieldedSyncComplete: state.unshielded.progress.isStrictlyComplete(),
      dustSyncComplete: state.dust.state.progress.isStrictlyComplete(),
      shieldedSyncComplete: state.shielded.state.progress.isStrictlyComplete(),
      unshieldedAvailableCoinCount: state.unshielded.availableCoins.length,
      unregisteredNightCoinCount: unregistered.length,
      dustAvailableCoinCount: state.dust.availableCoins.length,
      dustBalanceSpeck: String(dustBalance),
    }) + '\n');
  } finally {
    await wallet.stop();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Preprod status check failed at ${stage}: ${error instanceof Error ? error.name : 'UnknownError'}\n`);
  process.exitCode = 1;
});
