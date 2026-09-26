import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { test } from "node:test";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  EncryptedFileRiskEngineStore,
} from "../../src/engine/encrypted-file-store.ts";
import type { EngineSnapshot } from "../../src/engine/risk-engine.ts";

const WITNESS_TEXT = "private-close-witness-do-not-write-plaintext";

function snapshot(): EngineSnapshot {
  return {
    version: 1,
    positions: [{
      positionId: "private-position-42",
      risk: {
        side: "short",
        collateral: 1_000_000_000_000_000_123n,
        notional: 9_876_543_210_987_654_321_123n,
        entryPrice: 123_456_789_012_345_678_901n,
        accruedBorrowFee: 12_345n,
        accruedFundingFee: -98_765n,
      },
      policy: {
        minimumCollateral: 1_000n,
        maximumLeverageBps: 125_000n,
        maintenanceMarginBps: 500n,
        estimatedExitCost: 2_000n,
        protectiveBuffer: 30_000n,
        profitPayoutCap: 50_000n,
        riskSlotLiability: 50_000n,
        availableRiskReserve: 0n,
      },
      closeWitness: new TextEncoder().encode(WITNESS_TEXT),
    }],
    executions: [{
      positionId: "private-position-42",
      status: "pending",
      attempts: [
        {
          action: "protective_close",
          idempotencyKey: "attempt-before-retry",
          oracle: { price: 123_456_789_012_345_678_901n, sequence: 88_888_888_888_888_888_888n, observedAt: 1_780_000_000_123 },
          status: "failed",
          retryable: true,
          attemptCount: 1,
          retryAt: 1_780_000_000_456,
          failureCode: "SUBMIT_UNAVAILABLE",
        },
        {
          action: "liquidate",
          idempotencyKey: "attempt-current",
          oracle: { price: 1_234_567_890_123_456_789n, sequence: 88_888_888_888_888_888_889n, observedAt: 1_780_000_000_789 },
          status: "pending",
          retryable: false,
          attemptCount: 2,
          txId: "encrypted-transaction-id",
          retryAt: undefined,
          failureCode: undefined,
        },
      ],
    }],
    lastOracle: {
      price: 1_234_567_890_123_456_789n,
      sequence: 88_888_888_888_888_888_889n,
      observedAt: 1_780_000_000_789,
    },
  };
}

async function createStore() {
  const directory = await fs.mkdtemp(join(tmpdir(), "silence-risk-store-"));
  const filePath = join(directory, "risk-state.enc");
  const key = randomBytes(32);
  return {
    directory,
    filePath,
    key,
    store: new EncryptedFileRiskEngineStore(filePath, key),
  };
}

test("round-trips restart state, BigInts, undefined fields, and private witness bytes", async () => {
  const fixture = await createStore();
  const expected = snapshot();
  try {
    assert.equal(await fixture.store.load(), null);
    await fixture.store.save(expected);

    const ciphertext = await fs.readFile(fixture.filePath, "utf8");
    assert.equal(ciphertext.includes(WITNESS_TEXT), false);
    assert.equal(ciphertext.includes("private-position-42"), false);
    await fixture.store.close();

    const restarted = new EncryptedFileRiskEngineStore(fixture.filePath, fixture.key);
    try {
      const loaded = await restarted.load();
      assert.deepEqual(loaded, expected);
      assert.equal(loaded?.positions[0]?.closeWitness instanceof Uint8Array, true);
      assert.equal(Buffer.isBuffer(loaded?.positions[0]?.closeWitness), false);
      assert.equal(loaded?.positions[0]?.risk.notional, expected.positions[0]?.risk.notional);
      assert.equal("retryAt" in (loaded?.executions[0]?.attempts[1] ?? {}), true);
      assert.equal(loaded?.executions[0]?.attempts[1]?.retryAt, undefined);
    } finally {
      await restarted.close();
    }
  } finally {
    await fixture.store.close();
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects ciphertext tampering and malformed encrypted files without resetting state", async () => {
  const fixture = await createStore();
  try {
    await fixture.store.save(snapshot());
    const envelope = JSON.parse(await fs.readFile(fixture.filePath, "utf8")) as { ciphertext: string };
    const first = envelope.ciphertext[0] === "A" ? "B" : "A";
    envelope.ciphertext = first + envelope.ciphertext.slice(1);
    await fs.writeFile(fixture.filePath, JSON.stringify(envelope), { mode: 0o600 });

    await assert.rejects(fixture.store.load(), /corrupt or authentication failed/);
    await fs.writeFile(fixture.filePath, "not an encrypted snapshot", { mode: 0o600 });
    await assert.rejects(fixture.store.load(), /corrupt or authentication failed/);
  } finally {
    await fixture.store.close();
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects a wrong key and leaves the encrypted snapshot untouched", async () => {
  const fixture = await createStore();
  const wrongKey = randomBytes(32);
  try {
    await fixture.store.save(snapshot());
    const before = await fs.readFile(fixture.filePath);
    await fixture.store.close();

    const wrongKeyStore = new EncryptedFileRiskEngineStore(fixture.filePath, wrongKey);
    try {
      await assert.rejects(wrongKeyStore.load(), /corrupt or authentication failed/);
      assert.deepEqual(await fs.readFile(fixture.filePath), before);
    } finally {
      await wrongKeyStore.close();
    }
  } finally {
    await fixture.store.close();
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});

test("an atomic replacement failure keeps the previous state and removes the encrypted temp file", async (t) => {
  const fixture = await createStore();
  const previous = snapshot();
  const replacement = { ...snapshot(), lastOracle: { price: 777n, sequence: 999n, observedAt: 1_780_000_001_000 } };
  try {
    await fixture.store.save(previous);
    const before = await fs.readFile(fixture.filePath);
    const renameMock = t.mock.method(fs, "rename", async () => {
      throw new Error("simulated atomic replacement failure");
    });

    await assert.rejects(fixture.store.save(replacement), /simulated atomic replacement failure/);
    renameMock.mock.restore();

    assert.deepEqual(await fixture.store.load(), previous);
    assert.deepEqual(await fs.readFile(fixture.filePath), before);
    assert.deepEqual((await fs.readdir(fixture.directory)).sort(), ["risk-state.enc", "risk-state.enc.lock"]);
  } finally {
    await fixture.store.close();
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});

test("uses 0600 files, a 0700 parent directory, and an exclusive writer lock", async () => {
  const fixture = await createStore();
  const competing = new EncryptedFileRiskEngineStore(fixture.filePath, fixture.key);
  try {
    assert.equal(await fixture.store.load(), null);
    await assert.rejects(competing.load(), /already held by a writer/);

    await fixture.store.save(snapshot());
    const directoryMode = (await fs.stat(fixture.directory)).mode & 0o777;
    const fileMode = (await fs.stat(fixture.filePath)).mode & 0o777;
    const lockMode = (await fs.stat(`${fixture.filePath}.lock`)).mode & 0o777;
    assert.equal(directoryMode, 0o700);
    assert.equal(fileMode, 0o600);
    assert.equal(lockMode, 0o600);

    await fixture.store.close();
    assert.deepEqual(await competing.load(), snapshot());
  } finally {
    await fixture.store.close();
    await competing.close();
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});

test("fails closed on a stale lock until an operator verifies and removes it", async () => {
  const fixture = await createStore();
  const lockPath = `${fixture.filePath}.lock`;
  const absentPid = 2_147_483_647;
  try {
    assert.throws(
      () => process.kill(absentPid, 0),
      (error: NodeJS.ErrnoException) => error.code === "ESRCH",
    );
    await fs.writeFile(lockPath, JSON.stringify({
      version: 1,
      pid: absentPid,
      host: hostname(),
      token: "stale-lock-token",
    }), { mode: 0o600 });
    const originalLock = await fs.readFile(lockPath);

    const recovered = new EncryptedFileRiskEngineStore(fixture.filePath, fixture.key);
    try {
      await assert.rejects(recovered.load(), /already held by a writer/);
      assert.deepEqual(await fs.readFile(lockPath), originalLock);

      // Simulate operator recovery only after the dead PID has been checked.
      await fs.unlink(lockPath);
      assert.equal(await recovered.load(), null);
    } finally {
      await recovered.close();
    }
    await assert.rejects(fs.access(lockPath));
  } finally {
    await fixture.store.close();
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});

test("requires a caller-supplied 32-byte key", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "silence-risk-store-key-"));
  try {
    assert.throws(() => new EncryptedFileRiskEngineStore(join(directory, "state.enc"), new Uint8Array(31)), /exactly 32 bytes/);
    assert.throws(() => new EncryptedFileRiskEngineStore(join(directory, "state.enc"), new Uint8Array()), /exactly 32 bytes/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
