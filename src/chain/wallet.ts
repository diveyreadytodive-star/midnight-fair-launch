import { Buffer } from 'node:buffer';

import * as ledger from '@midnight-ntwrk/midnight-js-protocol/ledger';
import {
  DustWallet,
  HDWallet,
  NoOpTransactionHistoryStorage,
  PublicKey,
  Roles,
  ShieldedWallet,
  UnshieldedWallet,
  WalletFacade,
  createKeystore,
} from '@midnight-ntwrk/wallet-sdk';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

export interface LocalNetworkConfig {
  readonly networkId: 'undeployed' | 'preprod';
  readonly indexer: string;
  readonly indexerWS: string;
  readonly node: string;
  readonly proofServer: string;
}

export type SilenceWalletContext = {
  readonly wallet: Awaited<ReturnType<typeof WalletFacade.init>>;
  readonly shieldedSecretKeys: ReturnType<typeof ledger.ZswapSecretKeys.fromSeed>;
  readonly dustSecretKey: ReturnType<typeof ledger.DustSecretKey.fromSeed>;
  readonly accountId: string;
  stop(): Promise<void>;
};

function decodeSeed(seedHex: string): Uint8Array {
  const normalized = seedHex.trim().replace(/^0x/i, '');
  if (!/^(?:[0-9a-fA-F]{2}){16,64}$/.test(normalized)) {
    throw new Error('SILENCE_LOCAL_TEST_SEED must be 16–64 bytes of hex.');
  }
  return new Uint8Array(Buffer.from(normalized, 'hex'));
}

/**
 * Opens a headless wallet without serializing its seed or wallet state.
 * Callers own the seed and must not send it to the operator or log it.
 */
export async function createSilenceWallet(
  seedHex: string,
  network: LocalNetworkConfig,
): Promise<SilenceWalletContext> {
  setNetworkId(network.networkId);

  const hdWallet = HDWallet.fromSeed(decodeSeed(seedHex));
  if (hdWallet.type !== 'seedOk') throw new Error('Local test wallet seed was rejected.');
  const derivation = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derivation.type !== 'keysDerived') throw new Error('Local test wallet key derivation failed.');
  const roleKeys = derivation.keys;
  hdWallet.hdWallet.clear();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(roleKeys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(roleKeys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(roleKeys[Roles.NightExternal], network.networkId);
  const configuration = {
    networkId: network.networkId,
    indexerClientConnection: {
      indexerHttpUrl: network.indexer,
      indexerWsUrl: network.indexerWS,
    },
    provingServerUrl: new URL(network.proofServer),
    relayURL: new URL(network.node.replace(/^http/, 'ws')),
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
  };
  const wallet = await WalletFacade.init({
    configuration,
    shielded: async (config) => ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
    unshielded: async (config) =>
      UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: async (config) =>
      DustWallet(config).startWithSecretKey(
        dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
      ),
  });
  await wallet.start(shieldedSecretKeys, dustSecretKey);

  return {
    wallet,
    shieldedSecretKeys,
    dustSecretKey,
    accountId: unshieldedKeystore.getBech32Address().toString(),
    stop: () => wallet.stop(),
  };
}
