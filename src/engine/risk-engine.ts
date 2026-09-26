import { randomUUID } from "node:crypto";
import {
  calculatePositionRisk,
  type PositionRiskInput,
  type PositionRiskResult,
  type RiskPolicy,
} from "../risk/calculator.ts";

export type CloseAction = "protective_close" | "liquidate";
export type CloseStatus = "pending" | "confirmed" | "failed";

export interface OracleUpdate {
  readonly price: bigint;
  readonly sequence: bigint;
  /** Unix time in milliseconds from the oracle feed. */
  readonly observedAt: number;
}

/**
 * Private input required to assess and prove a close. Stores must persist this
 * data durably and privately; it must never be sent to the engine logger.
 */
export interface ManagedPosition {
  readonly positionId: string;
  readonly risk: Omit<PositionRiskInput, "markPrice">;
  readonly policy: RiskPolicy;
  /** Opaque, close-only witness material. This is not a wallet seed. */
  readonly closeWitness: Uint8Array;
}

export interface CloseAttempt {
  readonly action: CloseAction;
  readonly idempotencyKey: string;
  readonly oracle: OracleUpdate;
  readonly status: CloseStatus;
  readonly retryable: boolean;
  readonly attemptCount: number;
  readonly txId?: string;
  readonly retryAt?: number;
  readonly failureCode?:
    | "SUBMIT_UNAVAILABLE"
    | "SUBMISSION_UNKNOWN"
    | "RECEIPT_UNAVAILABLE"
    | "CHAIN_REJECTED"
    | "NOT_SUBMITTED";
}

export interface PositionExecution {
  readonly positionId: string;
  /** Mirrors the most recent attempt; a confirmed attempt is terminal. */
  readonly status: CloseStatus;
  readonly attempts: readonly CloseAttempt[];
}

export interface EngineSnapshot {
  readonly version: 1;
  readonly positions: readonly ManagedPosition[];
  readonly executions: readonly PositionExecution[];
  readonly lastOracle: OracleUpdate | null;
}

/**
 * A store implementation must provide durable, atomic snapshots and a single
 * writer for this engine. It must protect private witness data at rest.
 */
export interface RiskEngineStore {
  load(): Promise<EngineSnapshot | null>;
  save(snapshot: EngineSnapshot): Promise<void>;
}

export interface CloseSubmission {
  readonly positionId: string;
  readonly action: CloseAction;
  readonly idempotencyKey: string;
  readonly oracle: OracleUpdate;
  /** Private proof inputs for the adapter. The adapter must not log them. */
  readonly position: ManagedPosition;
  readonly risk: PositionRiskResult;
}

export type ReceiptResult =
  /** The adapter cannot establish whether submission was accepted. Pause safely. */
  | { readonly status: "unknown" }
  | { readonly status: "pending"; readonly txId?: string }
  | { readonly status: "confirmed"; readonly txId: string }
  | { readonly status: "failed"; readonly txId?: string; readonly retryable: boolean };

export type SubmissionResult =
  | { readonly status: "submitted"; readonly txId: string }
  /** Adapter guarantees the request was rejected and no transaction was accepted. */
  | { readonly status: "rejected"; readonly retryable: boolean };

/**
 * The adapter owns proof generation and transaction submission. Midnight may
 * not support lookup by idempotency key, so receipt checks use a known txId.
 * If acceptance is uncertain and no txId was durably recorded, return
 * `unknown`; the engine will pause rather than risk a duplicate submission.
 */
export interface ChainAdapter {
  submitClose(request: CloseSubmission): Promise<SubmissionResult>;
  checkReceipt(request: {
    readonly txId?: string;
  }): Promise<ReceiptResult>;
}

export interface SafeEngineEvent {
  readonly type:
    | "oracle_ignored"
    | "close_pending"
    | "close_confirmed"
    | "close_failed"
    | "liquidation_blocked"
    | "position_invalid";
  readonly reason?: "stale" | "old_sequence" | "duplicate_sequence";
  readonly action?: CloseAction;
  readonly sequence?: bigint;
  readonly failureCode?: CloseAttempt["failureCode"];
}

export interface RiskEngineLogger {
  record(event: SafeEngineEvent): void;
}

export interface RiskEngineOptions {
  readonly maxOracleAgeMs: number;
  readonly maxFutureSkewMs?: number;
  readonly retryDelayMs: number;
  readonly now?: () => number;
  readonly logger?: RiskEngineLogger;
}

export type OracleUpdateResult =
  | { readonly accepted: false; readonly reason: "stale" | "old_sequence" | "duplicate_sequence" }
  | { readonly accepted: true; readonly positionsEvaluated: number };

const EMPTY_SNAPSHOT: EngineSnapshot = {
  version: 1,
  positions: [],
  executions: [],
  lastOracle: null,
};

/**
 * Injectable state machine for a single always-on worker process. It performs
 * no chain operation directly and makes no claim beyond adapter receipts.
 */
export class RiskEngine {
  private snapshot: EngineSnapshot;
  private operationTail: Promise<void> = Promise.resolve();
  private readonly store: RiskEngineStore;
  private readonly chain: ChainAdapter;
  private readonly options: RiskEngineOptions;
  private readonly now: () => number;
  private readonly maxFutureSkewMs: number;
  private readonly logger?: RiskEngineLogger;
  private readonly alertedLiquidationEscalations = new Set<string>();
  private poisoned = false;

  private constructor(
    store: RiskEngineStore,
    chain: ChainAdapter,
    options: RiskEngineOptions,
    snapshot: EngineSnapshot,
  ) {
    this.store = store;
    this.chain = chain;
    this.options = options;
    this.snapshot = cloneSnapshot(snapshot);
    this.now = options.now ?? Date.now;
    this.maxFutureSkewMs = options.maxFutureSkewMs ?? 30_000;
    this.logger = options.logger;
    validateOptions(options);
  }

  /** Load durable state and reconcile/retry it before accepting new updates. */
  static async open(
    store: RiskEngineStore,
    chain: ChainAdapter,
    options: RiskEngineOptions,
  ): Promise<RiskEngine> {
    const stored = await store.load();
    const engine = new RiskEngine(store, chain, options, stored ?? EMPTY_SNAPSHOT);
    await engine.enqueue(async () => {
      await engine.processAll(engine.snapshot.lastOracle);
    });
    return engine;
  }

  /** Add or replace an active private position before the next oracle tick. */
  async registerPosition(position: ManagedPosition): Promise<void> {
    await this.enqueue(async () => {
      this.assertHealthy();
      assertManagedPosition(position);
      // Validate intrinsic position and policy constraints without requiring
      // free reserve: an already-open position may have consumed its slot.
      calculatePositionRisk(
        { ...position.risk, markPrice: position.risk.entryPrice },
        position.policy,
      );
      const existingExecution = this.getExecution(position.positionId);
      if (existingExecution?.status === "confirmed") {
        throw new Error("a confirmed position cannot be registered again");
      }
      if (existingExecution?.status === "pending") {
        throw new Error("cannot replace a position with a pending close");
      }
      const positions = this.snapshot.positions.filter(
        (current) => current.positionId !== position.positionId,
      );
      this.snapshot = {
        ...this.snapshot,
        positions: [...positions, clonePosition(position)],
      };
      await this.persist();
    });
  }

  /** Remove only a position that has no unresolved close attempt. */
  async removePosition(positionId: string): Promise<void> {
    await this.enqueue(async () => {
      this.assertHealthy();
      const execution = this.getExecution(positionId);
      if (execution?.status === "pending") {
        throw new Error("cannot remove a position with a pending close");
      }
      this.snapshot = {
        ...this.snapshot,
        positions: this.snapshot.positions.filter((position) => position.positionId !== positionId),
      };
      await this.persist();
    });
  }

  /** Accept only a fresh, strictly increasing oracle sequence. Sequence gaps are allowed. */
  async onOracleUpdate(update: OracleUpdate): Promise<OracleUpdateResult> {
    return this.enqueue(async () => {
      this.assertHealthy();
      assertOracleUpdate(update);
      const reason = this.oracleRejectionReason(update);
      if (reason) {
        // A previous save may have committed before reporting an I/O error.
        // Replaying the exact persisted update safely resumes its work.
        const current = this.snapshot.lastOracle;
        if (
          reason === "duplicate_sequence" && current &&
          current.price === update.price && current.observedAt === update.observedAt
        ) {
          await this.processAll(current);
        }
        this.record({ type: "oracle_ignored", reason });
        return { accepted: false, reason };
      }

      this.snapshot = { ...this.snapshot, lastOracle: cloneOracle(update) };
      await this.persist();
      const positionsEvaluated = await this.processAll(update);
      return { accepted: true, positionsEvaluated };
    });
  }

  /** Retry due failed submissions and reconcile receipt state from the saved feed. */
  async tick(): Promise<void> {
    await this.enqueue(async () => {
      this.assertHealthy();
      await this.processAll(this.snapshot.lastOracle);
    });
  }

  /** Read a defensive snapshot; callers must treat it as private position state. */
  async readSnapshot(): Promise<EngineSnapshot> {
    return this.enqueue(async () => {
      this.assertHealthy();
      return cloneSnapshot(this.snapshot);
    });
  }

  /** Reconcile an indeterminate save before resuming normal work. */
  async reloadDurableState(): Promise<void> {
    await this.enqueue(async () => {
      if (!this.poisoned) return;
      const stored = await this.store.load();
      if (stored === null) {
        throw new Error("risk-engine store has no recoverable snapshot");
      }
      const restored = cloneSnapshot(stored);
      this.snapshot = restored;
      this.poisoned = false;
    });
  }

  private oracleRejectionReason(
    update: OracleUpdate,
  ): "stale" | "old_sequence" | "duplicate_sequence" | undefined {
    const now = this.now();
    if (
      now - update.observedAt > this.options.maxOracleAgeMs ||
      update.observedAt - now > this.maxFutureSkewMs
    ) {
      return "stale";
    }
    const current = this.snapshot.lastOracle;
    if (current && update.sequence < current.sequence) return "old_sequence";
    if (current && update.sequence === current.sequence) return "duplicate_sequence";
    return undefined;
  }

  private async processAll(oracle: OracleUpdate | null): Promise<number> {
    if (!oracle) return 0;
    const positions = [...this.snapshot.positions];
    for (const position of positions) {
      await this.processPosition(position, oracle);
    }
    return positions.length;
  }

  private async processPosition(position: ManagedPosition, oracle: OracleUpdate): Promise<void> {
    let execution = this.getExecution(position.positionId);
    let latest = execution?.attempts.at(-1);

    if (execution?.status === "confirmed") return;

    // Reconcile an uncertain attempt before any retry or new-sequence proof.
    if (
      latest?.status === "pending" &&
      (latest.attemptCount > 0 || latest.txId !== undefined)
    ) {
      const stillPending = await this.reconcileAttempt(position.positionId, latest);
      execution = this.getExecution(position.positionId);
      latest = execution?.attempts.at(-1);
      if (stillPending) {
        if (latest?.action === "protective_close" && latest.status === "pending") {
          this.alertIfLiquidationBlocked(position, latest, oracle);
        }
        return;
      }
      if (execution?.status === "confirmed") return;
    }

    if (this.isOracleStale(oracle)) {
      if (latest?.status === "pending" && latest.attemptCount === 0 && !latest.txId) {
        this.markNotSubmitted(position.positionId, latest);
        await this.persist();
      }
      this.record({ type: "oracle_ignored", reason: "stale", sequence: oracle.sequence });
      return;
    }

    let risk: PositionRiskResult;
    try {
      risk = calculatePositionRisk({ ...position.risk, markPrice: oracle.price }, position.policy);
    } catch {
      // The exception may contain private amounts or malformed witness-adjacent data.
      if (latest?.status === "pending" && latest.attemptCount === 0 && !latest.txId) {
        this.markNotSubmitted(position.positionId, latest);
        await this.persist();
      }
      this.record({ type: "position_invalid", sequence: oracle.sequence });
      return;
    }

    const action = selectCloseAction(risk);
    if (!action) {
      if (latest?.status === "pending" && latest.attemptCount === 0 && !latest.txId) {
        this.markNotSubmitted(position.positionId, latest);
        await this.persist();
      }
      return;
    }

    let currentAttempt = latest;
    const sameActionAndSequence = currentAttempt?.action === action &&
      currentAttempt.oracle.sequence === oracle.sequence;
    if (currentAttempt?.status === "pending" && currentAttempt.attemptCount === 0 && !currentAttempt.txId) {
      if (sameActionAndSequence) {
        await this.submitAttempt(position, risk, currentAttempt);
        return;
      }
      this.markNotSubmitted(position.positionId, currentAttempt);
      await this.persist();
      currentAttempt = this.getExecution(position.positionId)?.attempts.at(-1);
    }
    if (currentAttempt?.status === "failed" && sameActionAndSequence) {
      if (!currentAttempt.retryable || (currentAttempt.retryAt !== undefined && currentAttempt.retryAt > this.now())) {
        return;
      }
      if (currentAttempt.failureCode !== "CHAIN_REJECTED") {
        await this.submitAttempt(position, risk, currentAttempt);
        return;
      }
    }

    const attempt: CloseAttempt = {
      action,
      idempotencyKey: randomUUID(),
      oracle: cloneOracle(oracle),
      status: "pending",
      retryable: false,
      attemptCount: 0,
    };
    this.upsertExecution(position.positionId, attempt);
    await this.persist();
    await this.submitAttempt(position, risk, attempt);
  }

  /** Returns true when an unresolved chain attempt must block new submissions. */
  private async reconcileAttempt(positionId: string, attempt: CloseAttempt): Promise<boolean> {
    let receipt: ReceiptResult;
    try {
      receipt = await this.chain.checkReceipt({
        ...(attempt.txId ? { txId: attempt.txId } : {}),
      });
    } catch {
      this.updateAttempt(positionId, attempt.idempotencyKey, {
        status: "pending",
        retryable: false,
        retryAt: this.now() + this.options.retryDelayMs,
        failureCode: "RECEIPT_UNAVAILABLE",
      });
      await this.persist();
      this.record({ type: "close_pending", action: attempt.action, sequence: attempt.oracle.sequence });
      return true;
    }

    if (receipt.status === "confirmed") {
      this.updateAttempt(positionId, attempt.idempotencyKey, {
        status: "confirmed",
        retryable: false,
        txId: receipt.txId,
        retryAt: undefined,
        failureCode: undefined,
      });
      await this.persist();
      this.record({ type: "close_confirmed", action: attempt.action, sequence: attempt.oracle.sequence });
      return false;
    }

    if (receipt.status === "pending" || receipt.status === "unknown") {
      this.updateAttempt(positionId, attempt.idempotencyKey, {
        status: "pending",
        retryable: false,
        ...(receipt.status === "pending" && receipt.txId ? { txId: receipt.txId } : {}),
        retryAt: undefined,
        failureCode: receipt.status === "unknown" ? "SUBMISSION_UNKNOWN" : undefined,
      });
      await this.persist();
      this.record({ type: "close_pending", action: attempt.action, sequence: attempt.oracle.sequence });
      return true;
    }

    const failureCode = "CHAIN_REJECTED";
    const retryable = receipt.retryable;
    this.updateAttempt(positionId, attempt.idempotencyKey, {
      status: "failed",
      retryable,
      ...(receipt.status === "failed" && receipt.txId ? { txId: receipt.txId } : {}),
      retryAt: retryable ? this.now() + this.options.retryDelayMs : undefined,
      failureCode,
    });
    await this.persist();
    this.record({
      type: "close_failed",
      action: attempt.action,
      sequence: attempt.oracle.sequence,
      failureCode,
    });
    return false;
  }

  private async submitAttempt(
    position: ManagedPosition,
    risk: PositionRiskResult,
    attempt: CloseAttempt,
  ): Promise<void> {
    const submitting = { ...attempt, status: "pending" as const, attemptCount: attempt.attemptCount + 1 };
    this.updateAttempt(position.positionId, attempt.idempotencyKey, submitting);
    await this.persist();

    let result: SubmissionResult;
    try {
      result = await this.chain.submitClose({
        positionId: position.positionId,
        action: attempt.action,
        idempotencyKey: attempt.idempotencyKey,
        oracle: cloneOracle(attempt.oracle),
        position: clonePosition(position),
        risk,
      });
    } catch {
      // A transport exception can happen after acceptance. Keep the attempt
      // unresolved until a receipt can be read; never blindly resubmit it.
      this.updateAttempt(position.positionId, attempt.idempotencyKey, {
        status: "pending",
        retryable: false,
        failureCode: "SUBMISSION_UNKNOWN",
      });
      await this.persist();
      this.record({ type: "close_pending", action: attempt.action, sequence: attempt.oracle.sequence });
      return;
    }

    if (result.status === "rejected") {
      this.updateAttempt(position.positionId, attempt.idempotencyKey, {
        status: "failed",
        retryable: result.retryable,
        retryAt: result.retryable ? this.now() + this.options.retryDelayMs : undefined,
        failureCode: "SUBMIT_UNAVAILABLE",
      });
      await this.persist();
      this.record({
        type: "close_failed",
        action: attempt.action,
        sequence: attempt.oracle.sequence,
        failureCode: "SUBMIT_UNAVAILABLE",
      });
      return;
    }

    if (typeof result.txId !== "string" || result.txId.length === 0) {
      // An invalid adapter response does not prove the transaction was rejected.
      this.updateAttempt(position.positionId, attempt.idempotencyKey, {
        status: "pending",
        retryable: false,
        failureCode: "SUBMISSION_UNKNOWN",
      });
      await this.persist();
      this.record({ type: "close_pending", action: attempt.action, sequence: attempt.oracle.sequence });
      return;
    }

    this.updateAttempt(position.positionId, attempt.idempotencyKey, {
      status: "pending",
      retryable: false,
      txId: result.txId,
      retryAt: undefined,
      failureCode: undefined,
    });
    await this.persist();
    await this.reconcileAttempt(position.positionId, {
      ...submitting,
      txId: result.txId,
    });
  }

  private getExecution(positionId: string): PositionExecution | undefined {
    return this.snapshot.executions.find((execution) => execution.positionId === positionId);
  }

  private upsertExecution(positionId: string, attempt: CloseAttempt): void {
    const current = this.getExecution(positionId);
    const execution: PositionExecution = {
      positionId,
      status: attempt.status,
      attempts: [...(current?.attempts ?? []), cloneAttempt(attempt)],
    };
    this.snapshot = {
      ...this.snapshot,
      executions: [
        ...this.snapshot.executions.filter((entry) => entry.positionId !== positionId),
        execution,
      ],
    };
  }

  private updateAttempt(
    positionId: string,
    idempotencyKey: string,
    patch: Partial<CloseAttempt>,
  ): void {
    const current = this.getExecution(positionId);
    if (!current) throw new Error("cannot update a close attempt without an execution record");
    const attempts = current.attempts.map((attempt) =>
      attempt.idempotencyKey === idempotencyKey ? { ...attempt, ...patch } : attempt,
    );
    const latest = attempts.at(-1);
    if (!latest) throw new Error("execution record lost its close attempts");
    this.snapshot = {
      ...this.snapshot,
      executions: this.snapshot.executions.map((entry) =>
        entry.positionId === positionId
          ? { ...entry, status: latest.status, attempts }
          : entry,
      ),
    };
  }

  private markNotSubmitted(positionId: string, attempt: CloseAttempt): void {
    this.updateAttempt(positionId, attempt.idempotencyKey, {
      status: "failed",
      retryable: false,
      retryAt: undefined,
      failureCode: "NOT_SUBMITTED",
    });
    this.record({
      type: "close_failed",
      action: attempt.action,
      sequence: attempt.oracle.sequence,
      failureCode: "NOT_SUBMITTED",
    });
  }

  private isOracleStale(oracle: OracleUpdate): boolean {
    const now = this.now();
    return now - oracle.observedAt > this.options.maxOracleAgeMs ||
      oracle.observedAt - now > this.maxFutureSkewMs;
  }

  private alertIfLiquidationBlocked(
    position: ManagedPosition,
    pendingAttempt: CloseAttempt,
    currentOracle: OracleUpdate,
  ): void {
    if (currentOracle.sequence <= pendingAttempt.oracle.sequence || this.isOracleStale(currentOracle)) {
      return;
    }
    try {
      const risk = calculatePositionRisk(
        { ...position.risk, markPrice: currentOracle.price },
        position.policy,
      );
      if (!risk.isLiquidatable) return;
    } catch {
      this.record({ type: "position_invalid", sequence: currentOracle.sequence });
      return;
    }

    const alertKey = `${pendingAttempt.idempotencyKey}:${currentOracle.sequence}`;
    if (this.alertedLiquidationEscalations.has(alertKey)) return;
    this.alertedLiquidationEscalations.add(alertKey);
    this.record({
      type: "liquidation_blocked",
      action: "liquidate",
      sequence: currentOracle.sequence,
    });
  }

  private async persist(): Promise<void> {
    const candidate = cloneSnapshot(this.snapshot);
    try {
      await this.store.save(candidate);
      this.snapshot = cloneSnapshot(candidate);
    } catch (error) {
      // Save can fail before or after an atomic write. Reload to determine
      // which snapshot is durable. If that cannot be established, halt.
      try {
        const stored = await this.store.load();
        if (stored === null) {
          this.poisoned = true;
          throw error;
        }
        const restored = cloneSnapshot(stored);
        this.snapshot = restored;
      } catch {
        // Do not allow stale in-memory state to be used after an unknown write.
        this.poisoned = true;
        throw error;
      }
      throw error;
    }
  }

  private assertHealthy(): void {
    if (this.poisoned) {
      throw new Error("risk engine is halted because durable state is indeterminate; reload is required");
    }
  }

  private record(event: SafeEngineEvent): void {
    try {
      this.logger?.record(event);
    } catch {
      // Logging failures must not expose or interrupt private risk processing.
    }
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function selectCloseAction(risk: PositionRiskResult): CloseAction | undefined {
  if (risk.isLiquidatable) return "liquidate";
  if (risk.shouldProtectiveClose) return "protective_close";
  return undefined;
}

function validateOptions(options: RiskEngineOptions): void {
  for (const [name, value] of [
    ["maxOracleAgeMs", options.maxOracleAgeMs],
    ["retryDelayMs", options.retryDelayMs],
    ["maxFutureSkewMs", options.maxFutureSkewMs ?? 30_000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }
}

function assertOracleUpdate(update: OracleUpdate): void {
  if (typeof update.price !== "bigint" || update.price <= 0n) {
    throw new RangeError("oracle price must be a positive bigint");
  }
  if (typeof update.sequence !== "bigint" || update.sequence < 0n) {
    throw new RangeError("oracle sequence must be a non-negative bigint");
  }
  if (!Number.isSafeInteger(update.observedAt) || update.observedAt < 0) {
    throw new RangeError("oracle observedAt must be a non-negative safe integer");
  }
}

function assertManagedPosition(position: ManagedPosition): void {
  if (position.positionId.trim().length === 0) {
    throw new RangeError("positionId must not be empty");
  }
  if (!(position.closeWitness instanceof Uint8Array) || position.closeWitness.length === 0) {
    throw new RangeError("closeWitness must be a non-empty Uint8Array");
  }
}

function cloneSnapshot(snapshot: EngineSnapshot): EngineSnapshot {
  if (snapshot.version !== 1) throw new RangeError("unsupported risk-engine snapshot version");
  return {
    version: 1,
    positions: snapshot.positions.map(clonePosition),
    executions: snapshot.executions.map((execution) => ({
      ...execution,
      attempts: execution.attempts.map(cloneAttempt),
    })),
    lastOracle: snapshot.lastOracle ? cloneOracle(snapshot.lastOracle) : null,
  };
}

function clonePosition(position: ManagedPosition): ManagedPosition {
  return {
    ...position,
    risk: { ...position.risk },
    policy: { ...position.policy },
    closeWitness: new Uint8Array(position.closeWitness),
  };
}

function cloneAttempt(attempt: CloseAttempt): CloseAttempt {
  return {
    ...attempt,
    oracle: cloneOracle(attempt.oracle),
  };
}

function cloneOracle(oracle: OracleUpdate): OracleUpdate {
  return { ...oracle };
}
