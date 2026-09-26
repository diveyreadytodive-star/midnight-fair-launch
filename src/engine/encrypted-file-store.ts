import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import fs from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, resolve } from "node:path";
import type { EngineSnapshot, RiskEngineStore } from "./risk-engine.ts";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD = Buffer.from("SILENCE/RiskEngineStore/v1", "utf8");
const CORRUPT_STORE = "encrypted risk-engine store is corrupt or authentication failed";
const HELD_LOCK = "risk-engine store is already held by a writer";

type TaggedValue =
  | null
  | string
  | number
  | boolean
  | { readonly t: "undefined" }
  | { readonly t: "bigint"; readonly v: string }
  | { readonly t: "uint8array"; readonly v: string }
  | { readonly t: "array"; readonly v: readonly TaggedValue[] }
  | { readonly t: "object"; readonly v: readonly (readonly [string, TaggedValue])[] };

interface EncryptedEnvelope {
  readonly version: 1;
  readonly algorithm: "AES-256-GCM";
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

interface WriterLock {
  readonly version: 1;
  readonly pid: number;
  readonly host: string;
  readonly token: string;
}

/**
 * Durable, authenticated encryption for private risk-engine snapshots.
 *
 * A lock file serializes writers on one host. Call close() during shutdown so
 * another engine instance can open the store. An existing lock always blocks;
 * after a crash, an operator must confirm the recorded host is this host and
 * that its PID is absent before manually removing the lock. PID reuse may make
 * a stale lock look active. This is not a distributed lock or a multi-host
 * guarantee.
 */
export class EncryptedFileRiskEngineStore implements RiskEngineStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly key: Buffer;
  private readonly lockToken = randomUUID();
  private lockHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(filePath: string, encryptionKey: Uint8Array) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new TypeError("risk-engine store path must not be empty");
    }
    if (!(encryptionKey instanceof Uint8Array) || encryptionKey.byteLength !== KEY_BYTES) {
      throw new RangeError("risk-engine store key must contain exactly 32 bytes");
    }
    this.filePath = resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.key = Buffer.from(encryptionKey);
  }

  load(): Promise<EngineSnapshot | null> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.prepareDirectory();
      await this.acquireWriterLock();
      return this.readSnapshot();
    });
  }

  save(snapshot: EngineSnapshot): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.prepareDirectory();
      await this.acquireWriterLock();

      // Never replace a file that has become unreadable since load().
      await this.readSnapshot();
      const encoded = encodeValue(snapshot);
      const plaintext = Buffer.from(JSON.stringify(encoded), "utf8");
      const iv = randomBytes(IV_BYTES);
      let encrypted: Buffer | undefined;
      try {
        const cipher = createCipheriv("aes-256-gcm", this.key, iv);
        cipher.setAAD(AAD);
        encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const envelope: EncryptedEnvelope = {
          version: 1,
          algorithm: "AES-256-GCM",
          iv: iv.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          ciphertext: encrypted.toString("base64"),
        };
        await this.writeAtomically(Buffer.from(JSON.stringify(envelope), "utf8"));
      } finally {
        plaintext.fill(0);
        encrypted?.fill(0);
        iv.fill(0);
      }
    });
  }

  /** Release this store's single-host writer lock and erase its key copy. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.enqueue(async () => {
      if (this.closed) return;
      this.closed = true;
      const handle = this.lockHandle;
      this.lockHandle = undefined;
      let closeError: unknown;
      try {
        await handle?.close();
      } catch (error) {
        closeError = error;
      }
      try {
        await this.removeOwnedLock();
      } catch (error) {
        closeError ??= error;
      } finally {
        this.key.fill(0);
      }
      if (closeError) throw closeError;
    });
    return this.closePromise;
  }

  private async readSnapshot(): Promise<EngineSnapshot | null> {
    let file: Buffer;
    try {
      const metadata = await fs.lstat(this.filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
        throw new Error("risk-engine store file is not a private regular file");
      }
      file = await fs.readFile(this.filePath);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return null;
      throw error;
    }

    let plaintext: Buffer | undefined;
    try {
      const envelope = parseEnvelope(file);
      const iv = decodeBase64(envelope.iv);
      const tag = decodeBase64(envelope.tag);
      const ciphertext = decodeBase64(envelope.ciphertext);
      if (iv.byteLength !== IV_BYTES || tag.byteLength !== TAG_BYTES) {
        throw new Error(CORRUPT_STORE);
      }
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const value = decodeValue(JSON.parse(plaintext.toString("utf8")));
      assertSnapshot(value);
      return value;
    } catch {
      throw new Error(CORRUPT_STORE);
    } finally {
      plaintext?.fill(0);
      file.fill(0);
    }
  }

  private async writeAtomically(encryptedEnvelope: Buffer): Promise<void> {
    const temporaryPath = resolve(
      dirname(this.filePath),
      `.${basename(this.filePath)}.${randomUUID()}.tmp`,
    );
    let temporaryHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      temporaryHandle = await fs.open(temporaryPath, "wx", 0o600);
      await temporaryHandle.chmod(0o600);
      await temporaryHandle.writeFile(encryptedEnvelope);
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;

      await fs.rename(temporaryPath, this.filePath);
      const directoryHandle = await fs.open(dirname(this.filePath), "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      encryptedEnvelope.fill(0);
      await temporaryHandle?.close().catch(() => undefined);
      await fs.rm(temporaryPath, { force: true });
    }
  }

  private async prepareDirectory(): Promise<void> {
    const directory = dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await fs.lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("risk-engine store parent must be a real directory");
    }
    await fs.chmod(directory, 0o700);
  }

  private async acquireWriterLock(): Promise<void> {
    if (this.lockHandle) return;
    const lock: WriterLock = {
      version: 1,
      pid: process.pid,
      host: hostname(),
      token: this.lockToken,
    };

    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(this.lockPath, "wx", 0o600);
    } catch (error) {
      if (isErrorCode(error, "EEXIST")) throw new Error(HELD_LOCK);
      throw error;
    }

    try {
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify(lock), "utf8");
      await handle.sync();
      this.lockHandle = handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await this.removeOwnedLock();
      throw error;
    }
  }

  private async removeOwnedLock(): Promise<void> {
    try {
      const lock = JSON.parse(await fs.readFile(this.lockPath, "utf8")) as WriterLock;
      if (lock?.version === 1 && lock.token === this.lockToken) {
        await fs.unlink(this.lockPath);
      }
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("risk-engine store is closed");
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function encodeValue(value: unknown): TaggedValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("snapshot contains a non-finite number");
    return value;
  }
  if (typeof value === "undefined") return { t: "undefined" };
  if (typeof value === "bigint") return { t: "bigint", v: value.toString(10) };
  if (value instanceof Uint8Array) return { t: "uint8array", v: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return { t: "array", v: value.map(encodeValue) };
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("snapshot contains an unsupported object");
    }
    const record = value as Record<string, unknown>;
    return {
      t: "object",
      v: Object.keys(record).map((key) => [key, encodeValue(record[key])] as const),
    };
  }
  throw new TypeError("snapshot contains an unsupported value");
}

function decodeValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(CORRUPT_STORE);
  }
  const tagged = value as Record<string, unknown>;
  if (tagged.t === "undefined" && Object.keys(tagged).length === 1) return undefined;
  if (tagged.t === "bigint" && typeof tagged.v === "string" && Object.keys(tagged).length === 2) {
    if (!/^-?(0|[1-9]\d*)$/.test(tagged.v)) throw new Error(CORRUPT_STORE);
    return BigInt(tagged.v);
  }
  if (tagged.t === "uint8array" && typeof tagged.v === "string" && Object.keys(tagged).length === 2) {
    return new Uint8Array(decodeBase64(tagged.v));
  }
  if (tagged.t === "array" && Array.isArray(tagged.v) && Object.keys(tagged).length === 2) {
    return tagged.v.map(decodeValue);
  }
  if (tagged.t === "object" && Array.isArray(tagged.v) && Object.keys(tagged).length === 2) {
    const output: Record<string, unknown> = {};
    for (const entry of tagged.v) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
        throw new Error(CORRUPT_STORE);
      }
      if (Object.prototype.hasOwnProperty.call(output, entry[0])) throw new Error(CORRUPT_STORE);
      Object.defineProperty(output, entry[0], {
        value: decodeValue(entry[1]),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  }
  throw new Error(CORRUPT_STORE);
}

function parseEnvelope(value: Buffer): EncryptedEnvelope {
  const parsed = JSON.parse(value.toString("utf8")) as Record<string, unknown>;
  if (
    parsed.version !== 1 || parsed.algorithm !== "AES-256-GCM" ||
    typeof parsed.iv !== "string" || typeof parsed.tag !== "string" ||
    typeof parsed.ciphertext !== "string"
  ) {
    throw new Error(CORRUPT_STORE);
  }
  return parsed as unknown as EncryptedEnvelope;
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(CORRUPT_STORE);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error(CORRUPT_STORE);
  return decoded;
}

function assertSnapshot(value: unknown): asserts value is EngineSnapshot {
  if (
    !isRecord(value) || value.version !== 1 || !Array.isArray(value.positions) ||
    !Array.isArray(value.executions) ||
    (value.lastOracle !== null && !isOracle(value.lastOracle))
  ) {
    throw new Error(CORRUPT_STORE);
  }
  for (const position of value.positions) {
    if (
      !isRecord(position) || typeof position.positionId !== "string" ||
      !isRecord(position.risk) || !isRecord(position.policy) ||
      !(position.closeWitness instanceof Uint8Array) || position.closeWitness.length === 0
    ) {
      throw new Error(CORRUPT_STORE);
    }
  }
  for (const execution of value.executions) {
    if (
      !isRecord(execution) || typeof execution.positionId !== "string" ||
      !["pending", "confirmed", "failed"].includes(String(execution.status)) ||
      !Array.isArray(execution.attempts)
    ) {
      throw new Error(CORRUPT_STORE);
    }
    for (const attempt of execution.attempts) {
      if (
        !isRecord(attempt) || !["protective_close", "liquidate"].includes(String(attempt.action)) ||
        typeof attempt.idempotencyKey !== "string" || !isOracle(attempt.oracle) ||
        !["pending", "confirmed", "failed"].includes(String(attempt.status)) ||
        typeof attempt.retryable !== "boolean" || !Number.isSafeInteger(attempt.attemptCount)
      ) {
        throw new Error(CORRUPT_STORE);
      }
    }
  }
}

function isOracle(value: unknown): boolean {
  return isRecord(value) && typeof value.price === "bigint" &&
    typeof value.sequence === "bigint" && Number.isSafeInteger(value.observedAt);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorCode(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && "code" in value && value.code === code;
}
