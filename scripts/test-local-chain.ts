import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import {
  localTestNetwork,
  SilenceChainClient,
  type OwnerTargetWitness,
  type PositionTerms,
} from '../src/chain/client.js';
import { createSilenceWallet } from '../src/chain/wallet.js';

interface IndexedTransaction {
  readonly hash: string;
  readonly raw: string;
  readonly block: { readonly height: number };
  readonly contractActions: readonly {
    readonly address?: string;
    readonly __typename: string;
    readonly entryPoint?: string;
    readonly state?: string;
    readonly zswapState?: string;
  }[];
}

interface RecoveryManifest {
  readonly version: 1;
  readonly purpose: 'test-only-local-devnet';
  readonly createdAt: string;
  status: 'running' | 'recovery-required' | 'complete';
  stage: string;
  readonly network: 'undeployed';
  readonly seedReference: 'SILENCE_LOCAL_TEST_SEED environment variable; value not persisted';
  readonly stateDirectory: string;
  readonly privateStoragePassword: string;
  contractAddress: string | null;
  testTokenColor: string | null;
  readonly collateralAmountAtoms: '1000000000';
  ownerIntentPhase: 'none' | 'pending' | 'active' | 'closed' | 'unknown';
  readonly receipts: Record<string, { readonly sdkIdentifier: string; readonly blockHeight: number }>;
  publicPositionReadback?: {
    readonly ownerIdentityCommitment: string;
    readonly ownerRecipientCommitment: string;
    readonly positionCommitment: string;
    readonly positionActive: boolean;
    readonly settled: boolean;
  };
  readonly recoveryNotice: string;
}

const RECOVERY_DIRECTORY = join(process.cwd(), '.local', 'silence-phase1');
const RECOVERY_MANIFEST = join(RECOVERY_DIRECTORY, 'recovery.json');

function ensurePrivateDirectory(path: string, label: string): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
    stats = lstatSync(path);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(label + ' must be a real directory, not a symlink or file.');
  }
  if ((stats.mode & 0o777) !== 0o700) {
    throw new Error(label + ' must have mode 0700 before any test transaction is submitted.');
  }
}

function assertNoRecoveryManifest(): void {
  try {
    lstatSync(RECOVERY_MANIFEST);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(
    'An unresolved Local Devnet recovery manifest already exists at ' + RECOVERY_MANIFEST +
    '. No transaction was submitted by this run. Inspect and reconcile the preserved owner state before rerunning.',
  );
}

function assertPrivateFile(path: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile() || (stats.mode & 0o777) !== 0o600) {
    throw new Error('Local Devnet recovery manifest must be a regular mode-0600 file.');
  }
}

function writeRecoveryManifest(manifest: RecoveryManifest, create = false): void {
  const temporaryPath = create
    ? RECOVERY_MANIFEST
    : RECOVERY_MANIFEST + '.tmp-' + process.pid + '-' + randomUUID();
  const descriptor = openSync(temporaryPath, 'wx', 0o600);
  let writeFailure: unknown;
  try {
    chmodSync(temporaryPath, 0o600);
    writeFileSync(descriptor, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    fsyncSync(descriptor);
  } catch (error) {
    writeFailure = error;
  } finally {
    try {
      closeSync(descriptor);
    } catch (error) {
      writeFailure ??= error;
    }
  }
  if (writeFailure !== undefined) {
    rmSync(temporaryPath, { force: true });
    throw writeFailure;
  }
  assertPrivateFile(temporaryPath);
  if (!create) {
    try {
      renameSync(temporaryPath, RECOVERY_MANIFEST);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }
  assertPrivateFile(RECOVERY_MANIFEST);
  try {
    const directoryDescriptor = openSync(dirname(RECOVERY_MANIFEST), 'r');
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch {
    // Directory fsync is not supported by every local filesystem.
  }
}

function prepareRecoveryManifest(): RecoveryManifest {
  ensurePrivateDirectory(join(process.cwd(), '.local'), 'The ignored .local directory');
  ensurePrivateDirectory(RECOVERY_DIRECTORY, 'The SILENCE Local Devnet recovery directory');
  assertNoRecoveryManifest();

  const stateDirectory = join(RECOVERY_DIRECTORY, 'private-state-' + randomUUID());
  mkdirSync(stateDirectory, { mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  ensurePrivateDirectory(stateDirectory, 'The encrypted owner-state directory');

  const storagePassword = ['Silence-test!', randomBytes(32).toString('hex'), 'Aa9'].join('');
  const manifest: RecoveryManifest = {
    version: 1,
    purpose: 'test-only-local-devnet',
    createdAt: new Date().toISOString(),
    status: 'running',
    stage: 'preflight-complete-before-first-transaction',
    network: 'undeployed',
    seedReference: 'SILENCE_LOCAL_TEST_SEED environment variable; value not persisted',
    stateDirectory,
    privateStoragePassword: storagePassword,
    contractAddress: null,
    testTokenColor: null,
    collateralAmountAtoms: '1000000000',
    ownerIntentPhase: 'none',
    receipts: {},
    recoveryNotice: 'Contains only a test-only private-state password and reconciliation metadata. Never copy this file to a public repository or use it for real assets.',
  };
  try {
    writeRecoveryManifest(manifest, true);
  } catch (error) {
    rmSync(stateDirectory, { recursive: true, force: true });
    throw error;
  }
  return manifest;
}

function bigIntHex(value: bigint, width: 8, littleEndian: boolean): string {
  const bytes = new Uint8Array(width);
  let remaining = value;
  for (let i = 0; i < width; i += 1) {
    const offset = littleEndian ? i : width - 1 - i;
    bytes[offset] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return Buffer.from(bytes).toString('hex');
}

async function queryPublicTransaction(
  indexerUrl: string,
  txId: string,
  expectedBlockHeight: number,
): Promise<IndexedTransaction> {
  const identifier = txId.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{66}$/.test(identifier)) {
    throw new Error('SDK transaction identifier is not a 33-byte indexer identifier (length ' + identifier.length + ').');
  }
  const query = 'query Phase1Transaction { transactions(offset: { identifier: ' +
    JSON.stringify(identifier) +
    ' }) { hash raw block { height } contractActions { __typename ... on ContractCall { address entryPoint state zswapState } } } }';
  const response = await fetch(indexerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) throw new Error('Public transaction query failed with HTTP ' + response.status + '.');
  const body = await response.json() as {
    readonly data?: { readonly transactions?: readonly IndexedTransaction[] };
    readonly errors?: readonly { readonly message: string }[];
  };
  if (body.errors?.length) {
    throw new Error('Public transaction query was rejected by the indexer: ' + body.errors[0]?.message);
  }
  const transaction = body.data?.transactions?.[0];
  if (!transaction || typeof transaction.raw !== 'string') {
    throw new Error('Indexer did not return the finalized public transaction payload.');
  }
  if (transaction.block.height !== expectedBlockHeight) {
    throw new Error('Indexer transaction block does not match the finalized SDK receipt.');
  }
  return transaction;
}

async function expectRejectedOwnerClose(
  client: SilenceChainClient,
  terms: PositionTerms,
  positionSalt: Uint8Array,
  ownerCloseSecret: Uint8Array,
  ownerTarget: OwnerTargetWitness,
): Promise<{ readonly stage: string; readonly diagnostic: string }> {
  // This harness intentionally bypasses the owner intent loader so the actual
  // compiled circuit can be challenged with a forged/replayed witness. Keep
  // the low-level invocation private to this Local Devnet acceptance script.
  const testClient = client as unknown as {
    invoke(circuit: string, args: readonly unknown[]): Promise<{
      readonly receipt: { readonly txId: string };
    }>;
  };
  try {
    const result = await testClient.invoke('ownerClose', [
      terms,
      positionSalt,
      ownerCloseSecret,
      ownerTarget,
    ]);
    throw new Error('Adversarial ownerClose unexpectedly succeeded with tx ' + result.receipt.txId + '.');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Adversarial ownerClose unexpectedly succeeded')) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      stage: message.includes('finalized with status') ? 'chain-finality' : 'proof-or-pre-finality-submission',
      diagnostic: message.split('\n')[0]?.slice(0, 240) ?? 'rejected without a diagnostic message',
    };
  }
}

function containsBytes(rawHex: string, value: Uint8Array): boolean {
  return rawHex.toLowerCase().includes(Buffer.from(value).toString('hex').toLowerCase());
}

function containsInteger(rawHex: string, value: bigint): boolean {
  return rawHex.toLowerCase().includes(bigIntHex(value, 8, true)) ||
    rawHex.toLowerCase().includes(bigIntHex(value, 8, false));
}

async function main(): Promise<void> {
  ensurePrivateDirectory(join(process.cwd(), '.local'), 'The ignored .local directory');
  ensurePrivateDirectory(RECOVERY_DIRECTORY, 'The SILENCE Local Devnet recovery directory');
  assertNoRecoveryManifest();

  let localSeed = process.env.SILENCE_LOCAL_TEST_SEED?.trim();
  if (!localSeed) {
    throw new Error(
      'Set SILENCE_LOCAL_TEST_SEED to a funded Local Devnet test-only seed. The script never reads private-perps/.local.',
    );
  }
  // Do not keep the environment variable populated while the rest of the
  // test runs, and never print or persist its value.
  delete process.env.SILENCE_LOCAL_TEST_SEED;

  let recoveryManifest = prepareRecoveryManifest();
  const updateRecovery = (updates: Partial<RecoveryManifest>): void => {
    recoveryManifest = { ...recoveryManifest, ...updates };
    writeRecoveryManifest(recoveryManifest);
  };
  const stateDirectory = recoveryManifest.stateDirectory;
  const network = {
    ...localTestNetwork(recoveryManifest.privateStoragePassword),
    privateStateDir: stateDirectory,
  };
  let ownerWallet: Awaited<ReturnType<typeof createSilenceWallet>> | undefined;
  let client: SilenceChainClient | undefined;
  let contractAddress: string | undefined;
  let mintedColor: string | undefined;
  let positionCommitAttempted = false;
  let ownerCloseCompleted = false;
  let fullAcceptancePass = false;

  try {
    ownerWallet = await createSilenceWallet(localSeed, network);
    localSeed = '';
    await ownerWallet.wallet.waitForSyncedState();
    client = await SilenceChainClient.connect(ownerWallet, network);

    const networkDomain = createHash('sha256')
      .update('SILENCE/LOCAL-DEVNET/PHASE1/v1')
      .digest();
    updateRecovery({ stage: 'contract-deployment-submitting' });
    const deployment = await client.deploy(networkDomain);
    contractAddress = deployment.contractAddress;
    updateRecovery({
      stage: 'contract-deployed',
      contractAddress,
      receipts: {
        ...recoveryManifest.receipts,
        deploy: { sdkIdentifier: deployment.receipt.txId, blockHeight: deployment.receipt.blockHeight },
      },
    });
    const deployIndexed = await queryPublicTransaction(
      network.indexer,
      deployment.receipt.txId,
      deployment.receipt.blockHeight,
    );
    assert.ok(deployIndexed.contractActions.some((action) => action.__typename === 'ContractDeploy'));

    updateRecovery({ stage: 'test-collateral-mint-submitting' });
    const mint = await client.mintTestCollateral(randomBytes(32));
    updateRecovery({
      stage: 'test-collateral-minted',
      receipts: {
        ...recoveryManifest.receipts,
        mint: { sdkIdentifier: mint.receipt.txId, blockHeight: mint.receipt.blockHeight },
      },
    });
    const mintIndexed = await queryPublicTransaction(network.indexer, mint.receipt.txId, mint.receipt.blockHeight);
    assert.ok(mintIndexed.contractActions.some((action) => action.entryPoint === 'mintTestCollateral'));
    await ownerWallet.wallet.waitForSyncedState();
    const color = Buffer.from(mint.coin.color).toString('hex');
    mintedColor = color;
    const balanceAfterMint = await client.readShieldedBalance(color);
    assert.equal(balanceAfterMint, 1_000_000_000n);
    updateRecovery({
      stage: 'test-collateral-balance-verified',
      testTokenColor: color,
    });

    const terms: PositionTerms = {
      side: true,
      notionalAtoms: 512_345_679n,
      entryPriceTicks: 65_432_109_876n,
      guardBufferAtoms: 22_500_123n,
    };
    const positionSalt = randomBytes(32);
    const ownerCloseSecret = randomBytes(32);
    const ownerTarget: OwnerTargetWitness = {
      ownerRecipient: { bytes: client.getOwnerCoinPublicKey() },
      recipientSalt: randomBytes(32),
    };

    positionCommitAttempted = true;
    updateRecovery({
      stage: 'position-commit-submitting',
      ownerIntentPhase: 'pending',
    });
    const commitReceipt = await client.commitPosition({
      coin: mint.coin,
      terms,
      positionSalt,
      ownerCloseSecret,
      ownerTarget,
    });
    assert.equal(await client.readOwnerIntentPhase(), 'active');
    const activeState = await client.readPublicPosition();
    assert.equal(activeState.collateralValueAtoms, '1000000000');
    assert.ok(BigInt(activeState.collateralMtIndex) > 0n);
    assert.equal(activeState.positionActive, true);
    assert.equal(activeState.settled, false);
    assert.notEqual(activeState.positionCommitment, '00'.repeat(32));
    assert.equal(await client.readShieldedBalance(color), 0n);
    await assert.rejects(
      client.commitPosition({
        coin: mint.coin,
        terms: { ...terms, notionalAtoms: terms.notionalAtoms - 1n },
        positionSalt: randomBytes(32),
        ownerCloseSecret: randomBytes(32),
        ownerTarget: {
          ownerRecipient: { bytes: client.getOwnerCoinPublicKey() },
          recipientSalt: randomBytes(32),
        },
      }),
      /active owner position already exists/,
    );
    assert.equal(await client.readOwnerIntentPhase(), 'active');
    const stateAfterDuplicateCommit = await client.readPublicPosition();
    assert.equal(stateAfterDuplicateCommit.positionCommitment, activeState.positionCommitment);
    assert.equal(stateAfterDuplicateCommit.positionActive, true);
    assert.equal(await client.readShieldedBalance(color), 0n);
    updateRecovery({
      stage: 'position-commit-verified',
      ownerIntentPhase: 'active',
      publicPositionReadback: {
        ownerIdentityCommitment: activeState.ownerIdentityCommitment,
        ownerRecipientCommitment: activeState.ownerRecipientCommitment,
        positionCommitment: activeState.positionCommitment,
        positionActive: activeState.positionActive,
        settled: activeState.settled,
      },
      receipts: {
        ...recoveryManifest.receipts,
        commitPosition: { sdkIdentifier: commitReceipt.txId, blockHeight: commitReceipt.blockHeight },
      },
    });

    const firstFree = await client.readIndexerFirstFreeAt(commitReceipt.blockHeight);
    const openRaw = await queryPublicTransaction(network.indexer, commitReceipt.txId, commitReceipt.blockHeight);
    assert.ok(openRaw.contractActions.some((action) => action.entryPoint === 'commitPosition'));
    const openAction = openRaw.contractActions.find((action) => action.entryPoint === 'commitPosition');
    assert.ok(openAction, 'The public indexer did not return commitPosition contract state.');
    assert.equal(openAction.address, deployment.contractAddress);
    assert.ok(openAction.state && openAction.zswapState);
    const openPublicHex = [openRaw.raw, openAction.state, openAction.zswapState]
      .map((field) => field.replace(/^0x/i, ''))
      .join('');
    const privateTermsInOpenFields =
      containsBytes(openPublicHex, positionSalt) ||
      containsBytes(openPublicHex, ownerCloseSecret) ||
      containsBytes(openPublicHex, ownerTarget.recipientSalt) ||
      containsInteger(openPublicHex, terms.notionalAtoms) ||
      containsInteger(openPublicHex, terms.entryPriceTicks) ||
      containsInteger(openPublicHex, terms.guardBufferAtoms);
    assert.equal(privateTermsInOpenFields, false, 'Private position terms or owner secret appear in the tested open raw transaction or structured contract state.');

    const forgedCloseError = await expectRejectedOwnerClose(
      client,
      terms,
      positionSalt,
      randomBytes(32),
      ownerTarget,
    );
    const stateAfterForgedClose = await client.readPublicPosition();
    assert.equal(stateAfterForgedClose.positionActive, true);
    assert.equal(stateAfterForgedClose.settled, false);
    assert.equal(stateAfterForgedClose.positionCommitment, activeState.positionCommitment);
    assert.equal(stateAfterForgedClose.collateralValueAtoms, activeState.collateralValueAtoms);
    assert.equal(await client.readShieldedBalance(color), 0n);

    // commitPosition persisted the pending owner secret before submission and
    // activated it only after finalized receipt plus commitment readback.
    assert.equal(await client.readOwnerIntentPhase(), 'active');

    const balanceBeforeClose = await client.readShieldedBalance(color);
    assert.equal(balanceBeforeClose, 0n);
    updateRecovery({ stage: 'owner-close-submitting' });
    const closeReceipt = await client.ownerClose();
    ownerCloseCompleted = true;
    await ownerWallet.wallet.waitForSyncedState();
    const balanceAfterClose = await client.readShieldedBalance(color);
    assert.equal(balanceAfterClose, 1_000_000_000n);
    assert.equal(await client.readOwnerIntentPhase(), 'closed');
    updateRecovery({
      stage: 'owner-close-verified',
      ownerIntentPhase: 'closed',
      receipts: {
        ...recoveryManifest.receipts,
        ownerClose: { sdkIdentifier: closeReceipt.txId, blockHeight: closeReceipt.blockHeight },
      },
    });

    const closeRaw = await queryPublicTransaction(network.indexer, closeReceipt.txId, closeReceipt.blockHeight);
    assert.ok(closeRaw.contractActions.some((action) => action.entryPoint === 'ownerClose'));
    const closeAction = closeRaw.contractActions.find((action) => action.entryPoint === 'ownerClose');
    assert.ok(closeAction, 'The public indexer did not return ownerClose contract state.');
    assert.equal(closeAction.address, deployment.contractAddress);
    assert.ok(closeAction.state && closeAction.zswapState);
    const closePublicHex = [closeRaw.raw, closeAction.state, closeAction.zswapState]
      .map((field) => field.replace(/^0x/i, ''))
      .join('');
    assert.equal(containsBytes(closePublicHex, ownerCloseSecret), false);
    const ownerKeyVisibleOnClose = containsBytes(closePublicHex, ownerTarget.ownerRecipient.bytes);
    const finalState = await client.readPublicPosition();

    const replayCloseError = await expectRejectedOwnerClose(
      client,
      terms,
      positionSalt,
      ownerCloseSecret,
      ownerTarget,
    );
    const stateAfterReplay = await client.readPublicPosition();
    assert.equal(stateAfterReplay.positionActive, false);
    assert.equal(stateAfterReplay.settled, true);
    assert.equal(stateAfterReplay.positionCommitment, finalState.positionCommitment);
    assert.equal(stateAfterReplay.collateralValueAtoms, finalState.collateralValueAtoms);
    assert.equal(await client.readShieldedBalance(color), 1_000_000_000n);

    assert.equal(finalState.positionActive, false);
    assert.equal(finalState.settled, true);
    assert.equal(finalState.collateralValueAtoms, '1000000000');

    updateRecovery({
      status: 'complete',
      stage: 'all-receipts-privacy-and-owner-balance-checks-passed',
      ownerIntentPhase: 'closed',
    });
    fullAcceptancePass = true;

    process.stdout.write(JSON.stringify({
      checkedAt: new Date().toISOString(),
      scope: 'phase1-fixed-public-lot-custody-and-commitment-primitive',
      notACompletePerp: true,
      contractAddress: deployment.contractAddress,
      receipts: {
        deploy: deployment.receipt,
        mint: mint.receipt,
        commitPosition: commitReceipt,
        ownerClose: closeReceipt,
      },
      publicReadback: {
        collateralAtoms: activeState.collateralValueAtoms,
        collateralUnits: '1000',
        contractCoinMtIndex: activeState.collateralMtIndex,
        indexerFirstFreeAtCommitBlock: firstFree,
        decodedLedgerFieldsInspected: Object.keys(activeState),
        ownerRecipientCommitment: activeState.ownerRecipientCommitment,
        positionCommitment: activeState.positionCommitment,
        positionActiveAfterCommit: activeState.positionActive,
        settledAfterOwnerClose: finalState.settled,
      },
      privateWalletReadback: {
        balanceAtomsBeforeOwnerClose: balanceBeforeClose.toString(),
        balanceAtomsAfterOwnerClose: balanceAfterClose.toString(),
      },
      rawTransactionAudit: {
        deploySdkTransactionId: deployment.receipt.txId,
        deployIndexerTransactionHash: deployIndexed.hash,
        mintSdkTransactionId: mint.receipt.txId,
        mintIndexerTransactionHash: mintIndexed.hash,
        openSdkTransactionId: commitReceipt.txId,
        openIndexerTransactionHash: openRaw.hash,
        closeSdkTransactionId: closeReceipt.txId,
        closeIndexerTransactionHash: closeRaw.hash,
        publicOpenFieldsInspected: ['transaction.raw', 'contractCall.address', 'contractCall.entryPoint', 'contractCall.state', 'contractCall.zswapState', 'decoded public ledger fields'],
        targetedSecretAndIntegerEncodingsObservedInOpenFields: privateTermsInOpenFields,
        ownerCloseSecretFoundInCloseRaw: false,
        ownerCloseSecretObservedInClosePublicFields: false,
        ownerRecipientKeyVisibleInCloseRaw: ownerKeyVisibleOnClose,
      },
      adversarialChainAttempts: {
        wrongOwnerCloseSecret: {
          rejected: true,
          rejectionStage: forgedCloseError.stage,
          diagnostic: forgedCloseError.diagnostic,
          positionRemainedActive: stateAfterForgedClose.positionActive,
          ownerBalanceAtoms: '0',
        },
        duplicatePositionCommit: {
          rejectedBeforeProofOrSubmission: true,
          originalOwnerIntentClosedAfterward: await client.readOwnerIntentPhase() === 'closed',
          originalPositionCommitmentPreserved: stateAfterDuplicateCommit.positionCommitment === activeState.positionCommitment,
        },
        duplicateOwnerClose: {
          rejected: true,
          rejectionStage: replayCloseError.stage,
          diagnostic: replayCloseError.diagnostic,
          positionRemainedSettled: stateAfterReplay.settled,
          ownerBalanceAtoms: '1000000000',
        },
      },
      disclosures: [
        'The fixed 1000-unit collateral amount and QSCI mt_index are public.',
        'sendShielded requires disclosure of the committed owner recipient key on close in this compiler.',
        'Owner side, notional, entry price, guard, position salt, and ownerCloseSecret were not observed in the tested open raw/contract-state fields or decoded public ledger fields; this is scoped test evidence, not a general unlinkability claim.',
      ],
      negativeContractCases: [
        'Forged ownerCloseSecret is rejected by Compact circuit test.',
        'Forged side/notional/guard commitment is rejected by Compact circuit test.',
        'Changed owner recipient or recipient salt is rejected by Compact circuit test.',
        'A second close is rejected by Compact circuit test.',
      ],
  }, null, 2) + '\n');
  } finally {
    if (!fullAcceptancePass && client && contractAddress && positionCommitAttempted && !ownerCloseCompleted) {
      try {
        const state = await client.readPublicPosition();
        const phase = await client.readOwnerIntentPhase();
        updateRecovery({
          stage: 'failure-state-reconciliation',
          ownerIntentPhase: phase ?? 'unknown',
          publicPositionReadback: {
            ownerIdentityCommitment: state.ownerIdentityCommitment,
            ownerRecipientCommitment: state.ownerRecipientCommitment,
            positionCommitment: state.positionCommitment,
            positionActive: state.positionActive,
            settled: state.settled,
          },
        });
        if (state.positionActive && (phase === 'active' || phase === 'pending')) {
          const recoveryReceipt = await client.ownerClose();
          const recoveredState = await client.readPublicPosition();
          const recoveredBalance = mintedColor
            ? await client.readShieldedBalance(mintedColor)
            : 0n;
          if (
            !recoveredState.positionActive &&
            recoveredState.settled &&
            recoveredBalance === 1_000_000_000n
          ) {
            ownerCloseCompleted = true;
            updateRecovery({
              stage: 'failure-recovery-owner-close-readback-verified',
              ownerIntentPhase: 'closed',
              publicPositionReadback: {
                ownerIdentityCommitment: recoveredState.ownerIdentityCommitment,
                ownerRecipientCommitment: recoveredState.ownerRecipientCommitment,
                positionCommitment: recoveredState.positionCommitment,
                positionActive: recoveredState.positionActive,
                settled: recoveredState.settled,
              },
              receipts: {
                ...recoveryManifest.receipts,
                ownerClose: {
                  sdkIdentifier: recoveryReceipt.txId,
                  blockHeight: recoveryReceipt.blockHeight,
                },
              },
            });
          }
        }
      } catch {
        updateRecovery({ stage: 'failure-reconciliation-incomplete' });
      }
    }
    await client?.close();
    if (!client) await ownerWallet?.stop();
    if (fullAcceptancePass) {
      rmSync(stateDirectory, { recursive: true, force: true });
      rmSync(RECOVERY_MANIFEST, { force: true });
    } else {
      try {
        updateRecovery({ status: 'recovery-required' });
      } catch {
        // The initial protected manifest remains the minimum recovery record.
      }
      console.error(
        'Local Devnet acceptance did not complete. Encrypted owner state and its protected recovery manifest remain at ' +
        RECOVERY_MANIFEST + '. Reruns are blocked until this state is reconciled.',
      );
    }
  }
}

await main();
