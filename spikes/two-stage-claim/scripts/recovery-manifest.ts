import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface RecoveryReceipt {
  readonly txId: string;
  readonly status: 'SucceedEntirely';
  readonly blockHeight: number;
}

export interface RecoveryManifest {
  readonly version: 1;
  readonly runId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly phase:
    | 'prepared'
    | 'submitting'
    | 'submitted'
    | 'position_open'
    | 'closed_unclaimed'
    | 'claimed'
    | 'complete'
    | 'interrupted';
  readonly lastKnownPhase?: RecoveryManifest['phase'];
  readonly contractAddress: string | null;
  readonly contractMaintenanceSigningKey: string | null;
  readonly ownerSeedHex: string;
  readonly operatorSeedHex: string;
  readonly privateStoragePassword: string;
  readonly terms: {
    readonly side: boolean;
    readonly notionalAtoms: string;
    readonly entryPriceTicks: string;
    readonly guardBufferAtoms: string;
  };
  readonly positionSaltHex: string;
  readonly ownerCloseSecretHex: string;
  readonly operatorCloseSecretHex: string;
  readonly ownerRecipientCoinPublicKeyHex: string;
  readonly operatorCoinPublicKeyHex: string;
  readonly recipientSaltHex: string;
  readonly mintNonceHex: string;
  readonly mintedCoin?: {
    readonly nonceHex: string;
    readonly colorHex: string;
    readonly value: string;
  };
  readonly pendingOperation: string | null;
  readonly pendingTxId: string | null;
  readonly receipts: Readonly<Record<string, RecoveryReceipt>>;
  readonly negativeChecks: readonly string[];
  readonly lastDiagnostic?: string;
}

export interface RecoveryStatus {
  readonly phase: RecoveryManifest['phase'];
  readonly lastKnownPhase?: RecoveryManifest['phase'];
  readonly contractAddress: string | null;
  readonly pendingOperation: string | null;
  readonly pendingTxId: string | null;
  readonly receipts: Readonly<Record<string, RecoveryReceipt>>;
  readonly negativeChecks: readonly string[];
  readonly lastDiagnostic?: string;
  readonly updatedAt: string;
}

const MANIFEST_NAME = 'recovery.json';

function mode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

function assertDirectory(path: string, expectedMode: number): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('Recovery path is not a real directory.');
  }
  if ((stats.mode & 0o777) !== expectedMode) {
    throw new Error('Recovery directory permissions must be owner-only.');
  }
}

function assertManifestFile(path: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('Recovery manifest is not a regular file.');
  }
  if ((stats.mode & 0o777) !== 0o600) {
    throw new Error('Recovery manifest permissions must be owner read/write only.');
  }
}

function ensurePrivateDirectory(path: string): void {
  const parentPath = dirname(path);
  if (!existsSync(parentPath)) mkdirSync(parentPath, { mode: 0o700 });
  const parentStats = lstatSync(parentPath);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new Error('Recovery parent path is not a real directory.');
  }
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  assertDirectory(path, 0o700);
}

function assertManifestShape(value: unknown): asserts value is RecoveryManifest {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) {
    throw new Error('Recovery manifest is malformed or uses an unsupported version.');
  }
  const manifest = value as Partial<RecoveryManifest>;
  if (
    typeof manifest.runId !== 'string' ||
    typeof manifest.phase !== 'string' ||
    (manifest.contractMaintenanceSigningKey !== null && typeof manifest.contractMaintenanceSigningKey !== 'string') ||
    typeof manifest.ownerSeedHex !== 'string' ||
    typeof manifest.operatorSeedHex !== 'string' ||
    typeof manifest.privateStoragePassword !== 'string' ||
    !manifest.terms ||
    typeof manifest.positionSaltHex !== 'string' ||
    typeof manifest.ownerCloseSecretHex !== 'string' ||
    typeof manifest.operatorCloseSecretHex !== 'string' ||
    typeof manifest.ownerRecipientCoinPublicKeyHex !== 'string' ||
    typeof manifest.operatorCoinPublicKeyHex !== 'string' ||
    typeof manifest.recipientSaltHex !== 'string' ||
    typeof manifest.mintNonceHex !== 'string' ||
    !manifest.receipts ||
    !Array.isArray(manifest.negativeChecks)
  ) {
    throw new Error('Recovery manifest is missing required recovery fields.');
  }
}

export function readRecoveryManifest(directory: string): RecoveryManifest {
  assertDirectory(directory, 0o700);
  const path = join(directory, MANIFEST_NAME);
  assertManifestFile(path);
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assertManifestShape(parsed);
  return parsed;
}

export function readRecoveryStatus(directory: string): RecoveryStatus | null {
  if (!existsSync(directory)) return null;
  const manifest = readRecoveryManifest(directory);
  return {
    phase: manifest.phase,
    lastKnownPhase: manifest.lastKnownPhase,
    contractAddress: manifest.contractAddress,
    pendingOperation: manifest.pendingOperation,
    pendingTxId: manifest.pendingTxId,
    receipts: manifest.receipts,
    negativeChecks: manifest.negativeChecks,
    lastDiagnostic: manifest.lastDiagnostic,
    updatedAt: manifest.updatedAt,
  };
}

export function refuseExistingRecovery(directory: string): void {
  if (!existsSync(directory)) return;
  assertDirectory(directory, 0o700);
  const manifestPath = join(directory, MANIFEST_NAME);
  if (existsSync(manifestPath)) {
    // Validate protection before refusing, but do not return or print secrets.
    readRecoveryManifest(directory);
    throw new Error('An existing SILENCE recovery record requires review; refusing to start another run.');
  }
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Recovery directory is a symbolic link.');
  if (lstatSync(directory).isDirectory()) {
    throw new Error('An orphaned SILENCE recovery directory exists; refusing to guess whether a transaction was submitted.');
  }
}

export class RecoveryStore {
  readonly directory: string;
  private current: RecoveryManifest;

  private constructor(directory: string, initial: RecoveryManifest) {
    this.directory = directory;
    this.current = initial;
  }

  static create(directory: string, initial: RecoveryManifest): RecoveryStore {
    refuseExistingRecovery(directory);
    ensurePrivateDirectory(directory);
    const store = new RecoveryStore(directory, initial);
    store.write();
    return store;
  }

  get snapshot(): RecoveryManifest {
    return this.current;
  }

  update(patch: Partial<RecoveryManifest>): void {
    this.current = {
      ...this.current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.write();
  }

  beginOperation(operation: string): void {
    this.update({
      pendingOperation: operation,
      pendingTxId: null,
      lastDiagnostic: undefined,
    });
  }

  recordSubmitted(operation: string, txId: string): void {
    this.update({
      pendingOperation: operation,
      pendingTxId: txId,
    });
  }

  recordReceipt(operation: string, receipt: RecoveryReceipt, phase: RecoveryManifest['phase']): void {
    this.update({
      phase,
      lastKnownPhase: undefined,
      pendingOperation: null,
      pendingTxId: null,
      receipts: { ...this.current.receipts, [operation]: receipt },
    });
  }

  recordProofRejection(operation: string, diagnostic: string): void {
    this.update({
      phase: this.current.phase === 'interrupted'
        ? this.current.lastKnownPhase ?? 'prepared'
        : this.current.phase,
      lastKnownPhase: undefined,
      pendingOperation: null,
      pendingTxId: null,
      negativeChecks: [...this.current.negativeChecks, operation + ': ' + diagnostic],
    });
  }

  markInterrupted(diagnostic: string): void {
    this.update({
      phase: 'interrupted',
      lastKnownPhase: this.current.phase === 'interrupted'
        ? this.current.lastKnownPhase
        : this.current.phase,
      lastDiagnostic: diagnostic,
    });
  }

  removeAfterVerifiedComplete(): void {
    if (this.current.phase !== 'complete' || this.current.pendingOperation || this.current.pendingTxId) {
      throw new Error('Recovery data can be removed only after a verified complete owner claim.');
    }
    assertDirectory(this.directory, 0o700);
    rmSync(this.directory, { recursive: true, force: true });
  }

  private write(): void {
    assertDirectory(this.directory, 0o700);
    const path = join(this.directory, MANIFEST_NAME);
    const temporary = join(this.directory, '.recovery-' + process.pid + '-' + randomBytes(8).toString('hex'));
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(this.current, null, 2) + '\n', 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, path);
      chmodSync(path, 0o600);
      assertManifestFile(path);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
  }
}

export function recoveryFileMode(directory: string): { readonly directory: number; readonly file: number } {
  return {
    directory: mode(directory),
    file: mode(join(directory, MANIFEST_NAME)),
  };
}
