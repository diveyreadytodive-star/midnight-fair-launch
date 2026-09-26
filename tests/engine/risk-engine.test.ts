import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RiskEngine,
  type ChainAdapter,
  type CloseSubmission,
  type EngineSnapshot,
  type ManagedPosition,
  type OracleUpdate,
  type ReceiptResult,
  type RiskEngineLogger,
  type RiskEngineOptions,
  type RiskEngineStore,
  type SubmissionResult,
} from "../../src/engine/risk-engine.ts";
import {
  PRICE_TICKS_PER_USD,
  TOKEN_ATOMS_PER_UNIT,
  type RiskPolicy,
} from "../../src/risk/calculator.ts";

const atom = TOKEN_ATOMS_PER_UNIT;
const price = PRICE_TICKS_PER_USD;

class MemoryStore implements RiskEngineStore {
  value: EngineSnapshot | null = null;
  failNextSave = false;
  failNextAttemptCountSave = false;
  failNextTxIdSave = false;

  async load(): Promise<EngineSnapshot | null> {
    return this.value ? structuredClone(this.value) : null;
  }

  async save(snapshot: EngineSnapshot): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("simulated snapshot save interruption");
    }
    if (
      this.failNextAttemptCountSave &&
      snapshot.executions.some((execution) => execution.attempts.some((attempt) => attempt.attemptCount > 0))
    ) {
      this.failNextAttemptCountSave = false;
      throw new Error("simulated pre-submit save interruption");
    }
    if (
      this.failNextTxIdSave &&
      snapshot.executions.some((execution) => execution.attempts.some((attempt) => attempt.txId))
    ) {
      this.failNextTxIdSave = false;
      throw new Error("simulated durable-store interruption");
    }
    this.value = structuredClone(snapshot);
  }
}

class CommitThenThrowAndLoadFailureStore extends MemoryStore {
  commitThenThrow = false;
  failNextLoad = false;

  override async load(): Promise<EngineSnapshot | null> {
    if (this.failNextLoad) {
      this.failNextLoad = false;
      throw new Error("simulated reload outage");
    }
    return super.load();
  }

  override async save(snapshot: EngineSnapshot): Promise<void> {
    if (this.commitThenThrow) {
      this.commitThenThrow = false;
      this.value = structuredClone(snapshot);
      this.failNextLoad = true;
      throw new Error("simulated commit-then-throw");
    }
    await super.save(snapshot);
  }
}

class MockChain implements ChainAdapter {
  readonly submissions: CloseSubmission[] = [];
  readonly receiptRequests: Array<{ txId?: string }> = [];
  submit: (request: CloseSubmission) => Promise<SubmissionResult> = async () => ({
    status: "submitted",
    txId: `tx-${this.submissions.length}`,
  });
  receipt: (request: { txId?: string }) => Promise<ReceiptResult> = async (request) =>
    request.txId ? { status: "pending", txId: request.txId } : { status: "unknown" };

  async submitClose(request: CloseSubmission): Promise<SubmissionResult> {
    this.submissions.push(request);
    return this.submit(request);
  }

  async checkReceipt(request: { txId?: string }): Promise<ReceiptResult> {
    this.receiptRequests.push(request);
    return this.receipt(request);
  }
}

function policy(overrides: Partial<RiskPolicy> = {}): RiskPolicy {
  return {
    minimumCollateral: atom,
    maximumLeverageBps: 100_000n,
    maintenanceMarginBps: 500n,
    estimatedExitCost: 2n * atom,
    protectiveBuffer: 30n * atom,
    profitPayoutCap: 50n * atom,
    riskSlotLiability: 50n * atom,
    availableRiskReserve: 50n * atom,
    ...overrides,
  };
}

function position(positionId = "private-position-7"): ManagedPosition {
  return {
    positionId,
    risk: {
      side: "long",
      collateral: 100n * atom,
      notional: 500n * atom,
      entryPrice: 100n * price,
      accruedBorrowFee: 3n * atom,
      accruedFundingFee: 0n,
    },
    policy: policy(),
    closeWitness: new TextEncoder().encode("private-witness-DO-NOT-LOG"),
  };
}

function oracle(sequence: bigint, mark: bigint, observedAt: number): OracleUpdate {
  return { price: mark, sequence, observedAt };
}

function options(now: () => number, extra: Partial<RiskEngineOptions> = {}) {
  return {
    now,
    maxOracleAgeMs: 5_000,
    retryDelayMs: 100,
    ...extra,
  };
}

async function engineFor(
  store: MemoryStore,
  chain: MockChain,
  now: () => number,
  logger?: RiskEngineLogger,
): Promise<RiskEngine> {
  return RiskEngine.open(store, chain, options(now, logger ? { logger } : {}));
}

test("guard breach submits a protective close while equity remains above maintenance", async () => {
  const now = () => 100_000;
  const store = new MemoryStore();
  const chain = new MockChain();
  const engine = await engineFor(store, chain, now);

  await engine.registerPosition(position());
  await engine.onOracleUpdate(oracle(1n, 90n * price, now()));

  assert.equal(chain.submissions.length, 1);
  assert.equal(chain.submissions[0]?.action, "protective_close");
  assert.equal((await engine.readSnapshot()).executions[0]?.status, "pending");
});

test("invalid leverage is rejected before a position reaches durable storage", async () => {
  const now = () => 100_000;
  const store = new MemoryStore();
  const engine = await engineFor(store, new MockChain(), now);
  const invalid = position("invalid-leverage");

  await assert.rejects(
    engine.registerPosition({
      ...invalid,
      risk: { ...invalid.risk, notional: 1_001n * atom },
    }),
    /maximum leverage/,
  );

  assert.equal(store.value, null);
  assert.equal((await engine.readSnapshot()).positions.length, 0);
});

test("an opened position remains monitorable after free risk reserve is depleted", async () => {
  const now = () => 100_000;
  const store = new MemoryStore();
  const chain = new MockChain();
  const engine = await engineFor(store, chain, now);
  const openedPosition = {
    ...position("depleted-reserve"),
    policy: policy({ availableRiskReserve: 0n }),
  };

  await engine.registerPosition(openedPosition);
  await engine.onOracleUpdate(oracle(1n, 90n * price, now()));

  assert.equal(chain.submissions.length, 1);
  assert.equal(chain.submissions[0]?.action, "protective_close");
});

test("a large price gap and skipped oracle sequences select liquidation", async () => {
  const now = () => 100_000;
  const store = new MemoryStore();
  const chain = new MockChain();
  const engine = await engineFor(store, chain, now);

  await engine.registerPosition(position());
  await engine.onOracleUpdate(oracle(1n, 100n * price, now()));
  await engine.onOracleUpdate(oracle(7n, 84n * price, now()));

  assert.equal(chain.submissions.length, 1);
  assert.equal(chain.submissions[0]?.oracle.sequence, 7n);
  assert.equal(chain.submissions[0]?.action, "liquidate");
});

test("stale oracle updates are ignored and cannot submit a close", async () => {
  const now = () => 100_000;
  const store = new MemoryStore();
  const chain = new MockChain();
  const engine = await engineFor(store, chain, now);

  await engine.registerPosition(position());
  const result = await engine.onOracleUpdate(oracle(1n, 84n * price, now() - 5_001));

  assert.deepEqual(result, { accepted: false, reason: "stale" });
  assert.equal(chain.submissions.length, 0);
  assert.equal((await engine.readSnapshot()).lastOracle, null);
});

test("an oracle save failure rolls memory back so an exact retry is processed", async () => {
  const now = () => 100_000;
  const store = new MemoryStore();
  const chain = new MockChain();
  const engine = await engineFor(store, chain, now);
  await engine.registerPosition(position());
  store.failNextSave = true;

  await assert.rejects(engine.onOracleUpdate(oracle(1n, 90n * price, now())), /snapshot save/);
  assert.equal((await engine.readSnapshot()).lastOracle, null);

  const retry = await engine.onOracleUpdate(oracle(1n, 90n * price, now()));
  assert.equal(retry.accepted, true);
  assert.equal(chain.submissions.length, 1);
});

test("a saved zero-count close attempt submits safely after worker restart", async () => {
  const now = () => 100_000;
  const store = new MemoryStore();
  const chain = new MockChain();
  const engine = await engineFor(store, chain, now);
  await engine.registerPosition(position());

  // The pending attempt is durable, while the pre-submit count increment is not.
  store.failNextAttemptCountSave = true;
  await assert.rejects(engine.onOracleUpdate(oracle(1n, 90n * price, now())), /pre-submit/);
  assert.equal(chain.submissions.length, 0);
  assert.equal(store.value?.executions[0]?.attempts[0]?.attemptCount, 0);

  const restarted = await engineFor(store, chain, now);

  assert.equal(chain.submissions.length, 1);
  assert.equal(chain.submissions[0]?.action, "protective_close");
  assert.equal((await restarted.readSnapshot()).executions[0]?.status, "pending");
});

test("indeterminate save halts operations until durable state reload prevents resurrection", async () => {
  const now = () => 100_000;
  const store = new CommitThenThrowAndLoadFailureStore();
  const chain = new MockChain();
  const engine = await engineFor(store, chain, now);
  await engine.registerPosition(position("remove-me"));

  store.commitThenThrow = true;
  await assert.rejects(engine.removePosition("remove-me"), /commit-then-throw/);
  assert.equal(store.value?.positions.length, 0);
  await assert.rejects(engine.onOracleUpdate(oracle(1n, 84n * price, now())), /halted/);
  await assert.rejects(engine.readSnapshot(), /halted/);
  assert.equal(chain.submissions.length, 0);

  await engine.reloadDurableState();
  await engine.onOracleUpdate(oracle(1n, 84n * price, now()));

  assert.equal((await engine.readSnapshot()).positions.length, 0);
  assert.equal(chain.submissions.length, 0);
});

test("restart reconciles a known transaction receipt without submitting again", async () => {
  const now = () => 100_000;
  const store = new MemoryStore();
  const chain = new MockChain();
  const engine = await engineFor(store, chain, now);

  await engine.registerPosition(position());
  await engine.onOracleUpdate(oracle(1n, 90n * price, now()));
  assert.equal((await engine.readSnapshot()).executions[0]?.status, "pending");

  chain.receipt = async (request) => ({ status: "confirmed", txId: request.txId ?? "tx-recovered" });
  const recovered = await engineFor(store, chain, now);

  assert.equal(chain.submissions.length, 1);
  assert.equal((await recovered.readSnapshot()).executions[0]?.status, "confirmed");
});

test("duplicate and old updates do not create another close attempt", async () => {
  const now = () => 100_000;
  const store = new MemoryStore();
  const chain = new MockChain();
  const engine = await engineFor(store, chain, now);

  await engine.registerPosition(position());
  await engine.onOracleUpdate(oracle(3n, 90n * price, now()));
  const duplicate = await engine.onOracleUpdate(oracle(3n, 84n * price, now()));
  const old = await engine.onOracleUpdate(oracle(2n, 84n * price, now()));

  assert.deepEqual(duplicate, { accepted: false, reason: "duplicate_sequence" });
  assert.deepEqual(old, { accepted: false, reason: "old_sequence" });
  assert.equal(chain.submissions.length, 1);
  assert.equal((await engine.readSnapshot()).executions[0]?.attempts.length, 1);
});

test("a pending protective close blocks liquidation escalation and emits one redacted alert", async () => {
  const now = () => 100_000;
  const store = new MemoryStore();
  const chain = new MockChain();
  chain.receipt = async (request) => ({ status: "pending", txId: request.txId });
  const events: unknown[] = [];
  const engine = await engineFor(store, chain, now, { record: (event) => events.push(event) });

  await engine.registerPosition(position("escalation-position"));
  await engine.onOracleUpdate(oracle(1n, 90n * price, now()));
  await engine.onOracleUpdate(oracle(2n, 84n * price, now()));
  await engine.tick();

  const snapshot = await engine.readSnapshot();
  assert.equal(chain.submissions.length, 1);
  assert.equal(chain.submissions[0]?.action, "protective_close");
  assert.equal(snapshot.executions[0]?.status, "pending");
  assert.equal(
    events.filter((event) => (event as { type?: string }).type === "liquidation_blocked").length,
    1,
  );
  assert.equal(
    JSON.stringify(events, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ).includes("escalation-position"),
    false,
  );
});

test("a definitive transient rejection retries the same idempotent attempt after its delay", async () => {
  let clock = 100_000;
  const now = () => clock;
  const store = new MemoryStore();
  const chain = new MockChain();
  chain.submit = async (_request) => chain.submissions.length === 1
    ? { status: "rejected", retryable: true }
    : { status: "submitted", txId: "tx-retried" };
  chain.receipt = async (request) => ({ status: "confirmed", txId: request.txId ?? "tx-retried" });
  const engine = await engineFor(store, chain, now);

  await engine.registerPosition(position());
  await engine.onOracleUpdate(oracle(1n, 90n * price, now()));
  assert.equal((await engine.readSnapshot()).executions[0]?.status, "failed");

  clock += 101;
  await engine.tick();

  assert.equal(chain.submissions.length, 2);
  assert.equal(chain.submissions[0]?.idempotencyKey, chain.submissions[1]?.idempotencyKey);
  assert.equal((await engine.readSnapshot()).executions[0]?.status, "confirmed");
});

test("a retryable failed receipt creates a fresh attempt after the retry delay", async () => {
  let clock = 100_000;
  const now = () => clock;
  const store = new MemoryStore();
  const chain = new MockChain();
  chain.receipt = async (request) => request.txId === "tx-1"
    ? { status: "failed", txId: "tx-1", retryable: true }
    : { status: "confirmed", txId: request.txId ?? "tx-2" };
  const engine = await engineFor(store, chain, now);

  await engine.registerPosition(position());
  await engine.onOracleUpdate(oracle(1n, 90n * price, now()));
  assert.equal((await engine.readSnapshot()).executions[0]?.status, "failed");

  clock += 101;
  await engine.tick();

  const execution = (await engine.readSnapshot()).executions[0];
  assert.equal(chain.submissions.length, 2);
  assert.notEqual(chain.submissions[0]?.idempotencyKey, chain.submissions[1]?.idempotencyKey);
  assert.equal(execution?.attempts.length, 2);
  assert.equal(execution?.attempts[0]?.status, "failed");
  assert.equal(execution?.status, "confirmed");
});

test("a newer oracle sequence regenerates a failed close attempt with a fresh key", async () => {
  const now = () => 100_000;
  const store = new MemoryStore();
  const chain = new MockChain();
  chain.submit = async (_request) => chain.submissions.length === 1
    ? { status: "rejected", retryable: true }
    : { status: "submitted", txId: "tx-new-sequence" };
  const engine = await engineFor(store, chain, now);

  await engine.registerPosition(position());
  await engine.onOracleUpdate(oracle(1n, 90n * price, now()));
  await engine.onOracleUpdate(oracle(2n, 89n * price, now()));

  assert.equal(chain.submissions.length, 2);
  assert.equal(chain.submissions[1]?.oracle.sequence, 2n);
  assert.notEqual(chain.submissions[0]?.idempotencyKey, chain.submissions[1]?.idempotencyKey);
  assert.equal((await engine.readSnapshot()).executions[0]?.attempts.length, 2);
});

test("a restart with accepted submission but lost txId pauses on unknown receipt", async () => {
  const now = () => 100_000;
  const store = new MemoryStore();
  const chain = new MockChain();
  const engine = await engineFor(store, chain, now);
  await engine.registerPosition(position());

  // The chain accepts and returns an id, but durable persistence fails before
  // the id is recorded. This is the no-native-idempotency-lookup gap.
  store.failNextTxIdSave = true;
  await assert.rejects(engine.onOracleUpdate(oracle(1n, 90n * price, now())), /durable-store/);

  const restarted = await engineFor(store, chain, now);
  const snapshot = await restarted.readSnapshot();

  assert.equal(chain.submissions.length, 1);
  assert.equal(chain.receiptRequests.at(-1)?.txId, undefined);
  assert.equal(snapshot.executions[0]?.status, "pending");
  assert.equal(snapshot.executions[0]?.attempts[0]?.failureCode, "SUBMISSION_UNKNOWN");
});

test("structured logs omit position identifiers, amounts, and private witness bytes", async () => {
  const now = () => 100_000;
  const store = new MemoryStore();
  const chain = new MockChain();
  const events: unknown[] = [];
  const logger: RiskEngineLogger = { record: (event) => events.push(event) };
  const engine = await engineFor(store, chain, now, logger);

  await engine.registerPosition(position("private-position-log-check"));
  await engine.onOracleUpdate(oracle(1n, 90n * price, now()));

  const serialized = JSON.stringify(events, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  assert.equal(serialized.includes("private-position-log-check"), false);
  assert.equal(serialized.includes("private-witness-DO-NOT-LOG"), false);
  assert.equal(serialized.includes((500n * atom).toString()), false);
  assert.equal(serialized.includes("tx-1"), false);
});
