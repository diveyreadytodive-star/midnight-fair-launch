import { Buffer } from 'node:buffer';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
import {
  encodeCoinPublicKey,
  encodeContractAddress,
  sampleSigningKey,
} from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';

import type { SilenceWalletContext } from './wallet.js';

Reflect.set(globalThis as object, 'WebSocket', WebSocket);

export interface ChainConfig {
  readonly networkId: 'undeployed';
  readonly indexer: string;
  readonly indexerWS: string;
  readonly node: string;
  readonly proofServer: string;
  readonly contractName?: string;
  readonly artifactsDir: string;
  readonly privateStateDir: string;
  readonly privateStoragePassword: string;
}

export interface ChainReceipt {
  readonly txId: string;
  readonly status: 'SucceedEntirely';
  readonly blockHeight: number;
}

export interface PositionTerms {
  readonly side: boolean;
  readonly notionalAtoms: bigint;
  readonly entryPriceTicks: bigint;
  readonly guardBufferAtoms: bigint;
}

export interface OwnerTargetWitness {
  readonly ownerRecipient: { readonly bytes: Uint8Array };
  readonly recipientSalt: Uint8Array;
}

export interface CommitPositionInput {
  readonly coin: MintedCoin;
  readonly terms: PositionTerms;
  readonly positionSalt: Uint8Array;
  readonly ownerCloseSecret: Uint8Array;
  readonly ownerTarget: OwnerTargetWitness;
}

export interface MintedCoin {
  readonly nonce: Uint8Array;
  readonly color: Uint8Array;
  readonly value: bigint;
}

export interface PublicPositionSnapshot {
  readonly networkDomain: string;
  readonly marketId: string;
  readonly protocolVersion: string;
  readonly collateralValueAtoms: string;
  readonly collateralMtIndex: string;
  readonly ownerIdentityCommitment: string;
  readonly ownerRecipientCommitment: string;
  readonly positionCommitment: string;
  readonly positionActive: boolean;
  readonly settled: boolean;
}

type DynamicContractModule = {
  readonly Contract: new (...args: unknown[]) => unknown;
  readonly pureCircuits: {
    deriveOwnerIdentity(
      networkDomain: Uint8Array,
      marketId: Uint8Array,
      protocolVersion: bigint,
      contractAddress: Uint8Array,
      collateralLotAtoms: bigint,
      ownerCloseSecret: Uint8Array,
    ): Uint8Array;
    commitOwnerRecipient(
      networkDomain: Uint8Array,
      marketId: Uint8Array,
      protocolVersion: bigint,
      contractAddress: Uint8Array,
      collateralLotAtoms: bigint,
      ownerRecipient: { bytes: Uint8Array },
      recipientSalt: Uint8Array,
    ): Uint8Array;
    computePositionCommitment(
      networkDomain: Uint8Array,
      marketId: Uint8Array,
      protocolVersion: bigint,
      contractAddress: Uint8Array,
      collateralLotAtoms: bigint,
      ownerIdentityCommitment: Uint8Array,
      ownerRecipientCommitment: Uint8Array,
      terms: PositionTerms,
      positionSalt: Uint8Array,
    ): Uint8Array;
  };
  readonly ledger: (state: unknown) => {
    readonly networkDomain: Uint8Array;
    readonly marketId: Uint8Array;
    readonly protocolVersion: bigint;
    readonly escrowCoin: { readonly value: bigint; readonly mt_index: bigint };
    readonly ownerIdentityCommitment: Uint8Array;
    readonly ownerRecipientCommitment: Uint8Array;
    readonly positionCommitment: Uint8Array;
    readonly positionActive: boolean;
    readonly settled: boolean;
  };
};

interface OwnerIntent {
  readonly version: 1;
  readonly phase: 'pending' | 'active' | 'closed';
  readonly terms: PositionTerms;
  readonly positionSalt: Uint8Array;
  readonly ownerCloseSecret: Uint8Array;
  readonly ownerTarget: OwnerTargetWitness;
  readonly expectedOwnerIdentityCommitment: Uint8Array;
  readonly expectedOwnerRecipientCommitment: Uint8Array;
  readonly expectedPositionCommitment: Uint8Array;
}

function isOwnerIntentEnvelope(value: unknown): value is Pick<OwnerIntent, 'version' | 'phase'> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { readonly version?: unknown; readonly phase?: unknown };
  return candidate.version === 1 &&
    (candidate.phase === 'pending' || candidate.phase === 'active' || candidate.phase === 'closed');
}

const OWNER_INTENT_ID = 'silence-owner-position-v1';
const MARKET_ID = Uint8Array.from([
  ...new TextEncoder().encode('BTC-USD'),
  ...new Uint8Array(32 - new TextEncoder().encode('BTC-USD').length),
]);
const PROTOCOL_VERSION = 1n;
const FIXED_COLLATERAL_LOT_ATOMS = 1_000_000_000n;

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function stablePrivateStoragePasswordProvider(password: string): () => string {
  if (password.length === 0) throw new Error('Private-state storage password is required.');
  return () => password;
}

export class SilenceChainClient {
  private readonly publicDataProvider;
  private readonly zkConfigProvider: NodeZkConfigProvider<string>;
  private readonly providers;
  private readonly contractModule: DynamicContractModule;
  private readonly compiledContract;
  private address: string | undefined;
  private lastDeploymentNetworkDomain: Uint8Array | undefined;
  private positionIntentReservation = false;
  private closed = false;

  private constructor(
    private readonly walletContext: SilenceWalletContext,
    private readonly config: ChainConfig,
    publicDataProvider: ReturnType<typeof indexerPublicDataProvider>,
    zkConfigProvider: NodeZkConfigProvider<string>,
    contractModule: DynamicContractModule,
  ) {
    this.publicDataProvider = publicDataProvider;
    this.zkConfigProvider = zkConfigProvider;
    this.contractModule = contractModule;
    this.compiledContract = CompiledContract.make(
      config.contractName ?? 'silence',
      contractModule.Contract as never,
    ).pipe(
      CompiledContract.withWitnesses({} as never),
      CompiledContract.withCompiledFileAssets(config.artifactsDir),
    );

    const walletProvider = {
      getCoinPublicKey: () => walletContext.shieldedSecretKeys.coinPublicKey,
      getEncryptionPublicKey: () => walletContext.shieldedSecretKeys.encryptionPublicKey,
      async balanceTx(tx: unknown, ttl?: Date) {
        const recipe = await walletContext.wallet.balanceUnboundTransaction(
          tx as never,
          {
            shieldedSecretKeys: walletContext.shieldedSecretKeys,
            dustSecretKey: walletContext.dustSecretKey,
          },
          { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
        );
        return walletContext.wallet.finalizeRecipe(recipe);
      },
      submitTx: (tx: unknown) => walletContext.wallet.submitTransaction(tx as never),
    };

    this.providers = {
      privateStateProvider: levelPrivateStateProvider({
        accountId: walletContext.accountId,
        midnightDbName: join(config.privateStateDir, 'midnight-level-db'),
        privateStateStoreName: 'silence-private-states',
        signingKeyStoreName: 'silence-signing-keys',
        privateStoragePasswordProvider: stablePrivateStoragePasswordProvider(
          config.privateStoragePassword,
        ),
      }),
      publicDataProvider,
      zkConfigProvider,
      proofProvider: httpClientProofProvider(config.proofServer, zkConfigProvider),
      walletProvider,
      midnightProvider: walletProvider,
    };
  }

  static async connect(
    walletContext: SilenceWalletContext,
    config: ChainConfig,
  ): Promise<SilenceChainClient> {
    await mkdir(config.privateStateDir, { recursive: true, mode: 0o700 });
    setNetworkId(config.networkId);
    const publicDataProvider = indexerPublicDataProvider(config.indexer, config.indexerWS);
    const zkConfigProvider = new NodeZkConfigProvider(config.artifactsDir);
    const contractModule = await import(
      pathToFileURL(join(config.artifactsDir, 'contract/index.js')).href
    ) as DynamicContractModule;
    return new SilenceChainClient(
      walletContext,
      config,
      publicDataProvider,
      zkConfigProvider,
      contractModule,
    );
  }

  async deploy(networkDomain: Uint8Array): Promise<{ readonly contractAddress: string; readonly receipt: ChainReceipt }> {
    this.assertOpen();
    if (this.address) throw new Error('Contract is already deployed in this client.');

    const deployData = await createUnprovenDeployTx(
      { zkConfigProvider: this.zkConfigProvider, walletProvider: this.providers.walletProvider } as never,
      {
        compiledContract: this.compiledContract as never,
        args: [networkDomain],
        signingKey: sampleSigningKey(),
        initialPrivateState: undefined,
      } as never,
    );
    const contractAddress = String(deployData.public.contractAddress);
    const txId = await submitTxAsync(
      this.providers as never,
      { unprovenTx: deployData.private.unprovenTx } as never,
    );
    const receipt = await this.waitForReceipt(txId);
    this.address = contractAddress;
    this.lastDeploymentNetworkDomain = Uint8Array.from(networkDomain);
    this.providers.privateStateProvider.setContractAddress(contractAddress as never);
    return { contractAddress, receipt };
  }

  async setAddress(address: string): Promise<void> {
    this.assertOpen();
    const state = await this.publicDataProvider.queryContractState(address as never);
    if (!state) throw new Error('No contract state found at ' + address + '.');
    this.address = address;
    const ledger = this.contractModule.ledger((state as { data?: unknown }).data ?? state);
    this.lastDeploymentNetworkDomain = Uint8Array.from(ledger.networkDomain);
    this.providers.privateStateProvider.setContractAddress(address as never);
  }

  async mintTestCollateral(nonce: Uint8Array): Promise<{ readonly receipt: ChainReceipt; readonly coin: MintedCoin }> {
    const { receipt, privateResult } = await this.invoke('mintTestCollateral', [nonce]);
    const coin = privateResult as MintedCoin;
    if (!(coin.nonce instanceof Uint8Array) || !(coin.color instanceof Uint8Array)) {
      throw new Error('Test mint returned an invalid private coin result.');
    }
    return { receipt, coin };
  }

  async commitPosition(
    input: CommitPositionInput,
  ): Promise<ChainReceipt> {
    if (this.positionIntentReservation) {
      throw new Error('Another owner position commit is already being prepared.');
    }
    this.positionIntentReservation = true;
    let pendingIntent: OwnerIntent | undefined;
    try {
      const existingIntent = await this.providers.privateStateProvider.get(OWNER_INTENT_ID);
      if (existingIntent !== null && existingIntent !== undefined) {
        if (!isOwnerIntentEnvelope(existingIntent)) {
          throw new Error('Existing owner position intent is malformed; refusing to overwrite recoverable state.');
        }
        if (existingIntent.phase === 'active') {
          throw new Error('An active owner position already exists; close it before opening another.');
        }
        if (existingIntent.phase === 'pending') {
          throw new Error('A pending owner position intent must be reconciled before another commit.');
        }
        throw new Error('This deployed contract already has a settled position; a new deployment is required.');
      }

      const address = this.requireAddress();
      const networkDomain = this.lastDeploymentNetworkDomain;
      if (!networkDomain) throw new Error('Deployment domain is unavailable in this owner session.');
      const contractAddress = encodeContractAddress(address as never);
      const ownerIdentity = this.contractModule.pureCircuits.deriveOwnerIdentity(
        networkDomain,
        MARKET_ID,
        PROTOCOL_VERSION,
        contractAddress,
        FIXED_COLLATERAL_LOT_ATOMS,
        input.ownerCloseSecret,
      );
      const ownerRecipient = this.contractModule.pureCircuits.commitOwnerRecipient(
        networkDomain,
        MARKET_ID,
        PROTOCOL_VERSION,
        contractAddress,
        FIXED_COLLATERAL_LOT_ATOMS,
        input.ownerTarget.ownerRecipient,
        input.ownerTarget.recipientSalt,
      );
      const position = this.contractModule.pureCircuits.computePositionCommitment(
        networkDomain,
        MARKET_ID,
        PROTOCOL_VERSION,
        contractAddress,
        FIXED_COLLATERAL_LOT_ATOMS,
        ownerIdentity,
        ownerRecipient,
        input.terms,
        input.positionSalt,
      );
      pendingIntent = {
        version: 1,
        phase: 'pending',
        terms: input.terms,
        positionSalt: Uint8Array.from(input.positionSalt),
        ownerCloseSecret: Uint8Array.from(input.ownerCloseSecret),
        ownerTarget: {
          ownerRecipient: { bytes: Uint8Array.from(input.ownerTarget.ownerRecipient.bytes) },
          recipientSalt: Uint8Array.from(input.ownerTarget.recipientSalt),
        },
        expectedOwnerIdentityCommitment: Uint8Array.from(ownerIdentity),
        expectedOwnerRecipientCommitment: Uint8Array.from(ownerRecipient),
        expectedPositionCommitment: Uint8Array.from(position),
      };

      // Persist owner-only recovery material before submission. If submission
      // is uncertain, keep this pending record; never replace it with a new
      // witness until chain state has been reconciled by ownerClose().
      await this.providers.privateStateProvider.set(OWNER_INTENT_ID, pendingIntent);
    } finally {
      this.positionIntentReservation = false;
    }

    if (!pendingIntent) throw new Error('Owner position intent was not persisted.');
    const { receipt } = await this.invoke('commitPosition', [
      input.coin,
      input.terms,
      input.positionSalt,
      input.ownerCloseSecret,
      input.ownerTarget,
    ]);
    const publicState = await this.readPublicPosition();
    if (
      !publicState.positionActive ||
      publicState.settled ||
      publicState.ownerIdentityCommitment !== bytesToHex(pendingIntent.expectedOwnerIdentityCommitment) ||
      publicState.ownerRecipientCommitment !== bytesToHex(pendingIntent.expectedOwnerRecipientCommitment) ||
      publicState.positionCommitment !== bytesToHex(pendingIntent.expectedPositionCommitment)
    ) {
      throw new Error('Public position commitment did not match the owner-side pending intent.');
    }
    await this.providers.privateStateProvider.set(OWNER_INTENT_ID, {
      ...pendingIntent,
      phase: 'active',
    } satisfies OwnerIntent);
    return receipt;
  }

  async ownerClose(): Promise<ChainReceipt> {
    let intent = await this.providers.privateStateProvider.get(OWNER_INTENT_ID) as OwnerIntent | null;
    if (!intent || !isOwnerIntentEnvelope(intent)) {
      throw new Error('No active owner position is present in this private wallet state.');
    }
    if (intent.phase === 'pending') {
      const publicState = await this.readPublicPosition();
      if (
        !publicState.positionActive ||
        publicState.settled ||
        publicState.ownerIdentityCommitment !== bytesToHex(intent.expectedOwnerIdentityCommitment) ||
        publicState.ownerRecipientCommitment !== bytesToHex(intent.expectedOwnerRecipientCommitment) ||
        publicState.positionCommitment !== bytesToHex(intent.expectedPositionCommitment)
      ) {
        throw new Error('Pending owner intent does not match an active, unsettled public position; recovery remains blocked.');
      }
      intent = { ...intent, phase: 'active' };
      await this.providers.privateStateProvider.set(OWNER_INTENT_ID, intent);
    }
    if (intent.phase !== 'active') {
      throw new Error('No active owner position is present in this private wallet state.');
    }
    const { receipt } = await this.invoke('ownerClose', [
      intent.terms,
      intent.positionSalt,
      intent.ownerCloseSecret,
      intent.ownerTarget,
    ]);
    const publicState = await this.readPublicPosition();
    if (publicState.positionActive || !publicState.settled) {
      throw new Error('Owner close receipt did not match the public ledger readback.');
    }
    await this.providers.privateStateProvider.set(OWNER_INTENT_ID, {
      ...intent,
      phase: 'closed',
    } satisfies OwnerIntent);
    return receipt;
  }

  async readOwnerIntentPhase(): Promise<OwnerIntent['phase'] | null> {
    const intent = await this.providers.privateStateProvider.get(OWNER_INTENT_ID) as OwnerIntent | null;
    return intent?.version === 1 ? intent.phase : null;
  }

  async readPublicPosition(): Promise<PublicPositionSnapshot> {
    this.assertOpen();
    const address = this.requireAddress();
    const state = await this.publicDataProvider.queryContractState(address as never);
    if (!state) throw new Error('No contract state found at ' + address + '.');
    const ledger = this.contractModule.ledger((state as { data?: unknown }).data ?? state);
    return {
      networkDomain: bytesToHex(ledger.networkDomain),
      marketId: bytesToHex(ledger.marketId),
      protocolVersion: ledger.protocolVersion.toString(),
      collateralValueAtoms: ledger.escrowCoin.value.toString(),
      collateralMtIndex: ledger.escrowCoin.mt_index.toString(),
      ownerIdentityCommitment: bytesToHex(ledger.ownerIdentityCommitment),
      ownerRecipientCommitment: bytesToHex(ledger.ownerRecipientCommitment),
      positionCommitment: bytesToHex(ledger.positionCommitment),
      positionActive: ledger.positionActive,
      settled: ledger.settled,
    };
  }

  async readIndexerFirstFreeAt(blockHeight: number): Promise<string> {
    this.assertOpen();
    const result = await this.publicDataProvider.queryZSwapAndContractState(
      this.requireAddress() as never,
      { type: 'blockHeight', blockHeight },
    );
    if (!result) throw new Error('No Zswap state found at block ' + blockHeight + '.');
    return result[0].firstFree.toString();
  }

  async readShieldedBalance(rawTokenType: string): Promise<bigint> {
    const state = await this.walletContext.wallet.waitForSyncedState();
    return state.shielded.balances[rawTokenType] ?? 0n;
  }

  getOwnerCoinPublicKey(): Uint8Array {
    return encodeCoinPublicKey(this.walletContext.shieldedSecretKeys.coinPublicKey);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.walletContext.stop();
  }

  private async invoke(
    circuit: string,
    args: readonly unknown[],
  ): Promise<{ readonly receipt: ChainReceipt; readonly privateResult: unknown }> {
    this.assertOpen();
    const address = this.requireAddress();
    const options = createCallTxOptions(
      this.compiledContract as never,
      circuit as never,
      address as never,
      undefined,
      undefined,
      [...args] as never,
    );
    const submitted = await submitCallTxAsync(this.providers as never, options as never);
    const receipt = await this.waitForReceipt(submitted.txId);
    return {
      receipt,
      privateResult: (submitted.callTxData as { private: { result: unknown } }).private.result,
    };
  }

  private async waitForReceipt(txId: string): Promise<ChainReceipt> {
    const final = await this.publicDataProvider.watchForTxData(txId);
    if (final.status !== 'SucceedEntirely') {
      throw new Error('Transaction ' + txId + ' finalized with status ' + final.status + '.');
    }
    return { txId, status: 'SucceedEntirely', blockHeight: final.blockHeight };
  }

  private requireAddress(): string {
    if (!this.address) throw new Error('No contract address is connected.');
    return this.address;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SilenceChainClient is closed.');
  }
}

export function localTestNetwork(privateStoragePassword = process.env.SILENCE_PRIVATE_STORAGE_PASSWORD): ChainConfig {
  if (!privateStoragePassword) {
    throw new Error('Pass a stable SILENCE_PRIVATE_STORAGE_PASSWORD for the private-state store.');
  }
  return {
    networkId: 'undeployed',
    indexer: process.env.SILENCE_INDEXER_URL ?? 'http://127.0.0.1:28088/api/v4/graphql',
    indexerWS: process.env.SILENCE_INDEXER_WS_URL ?? 'ws://127.0.0.1:28088/api/v4/graphql/ws',
    node: process.env.SILENCE_NODE_URL ?? 'ws://127.0.0.1:29944',
    proofServer: process.env.SILENCE_PROOF_SERVER_URL ?? 'http://127.0.0.1:26300',
    artifactsDir: join(process.cwd(), 'contracts/managed/silence'),
    privateStateDir: process.env.SILENCE_PRIVATE_STATE_DIR ?? join(process.cwd(), '.local/chain-state'),
    privateStoragePassword,
  };
}
