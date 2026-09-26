import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FairLaunchCreateBusyError,
  FairLaunchCreateUnavailableError,
  FairLaunchInputError,
  FairLaunchRecoveryRequiredError,
  type FairLaunchCreateAdapter,
  type FairLaunchEntry,
  type FairLaunchSnapshot,
} from "../../src/api/fair-launch-create.ts";
import { createSilenceServer } from "../../src/api/http-server.ts";

const launch: FairLaunchEntry = {
  id: "a".repeat(64),
  contractAddress: "a".repeat(64),
  metadata: { name: "Meme Test Token", ticker: "MTT", imageUrl: null, description: "Local Devnet demo launch." },
  config: {
    inventoryAtoms: "600",
    reservePriceAtoms: "8",
    depositLotAtoms: "5000",
    commitWindowSeconds: 600,
    openWindowSeconds: 600,
  },
  phase: "commit",
  createdAt: "2026-09-26T00:00:00.000Z",
  metadataAnchored: true,
  metadataCommitmentHex: "c".repeat(64),
  artworkBytesAnchored: false,
  evidenceSource: "verified-local-devnet-create",
  receipts: {
    deploy: { txId: "d".repeat(64), transactionHash: "1".repeat(64), blockHeight: 100 },
    mint: { txId: "e".repeat(64), transactionHash: "2".repeat(64), blockHeight: 101 },
    fund: { txId: "f".repeat(64), transactionHash: "3".repeat(64), blockHeight: 102 },
  },
};

const snapshot: FairLaunchSnapshot = {
  live: true,
  writable: true,
  network: "local-devnet",
  mode: "local-devnet-operator-demo",
  capabilities: { canCreate: true },
  launches: [launch],
};

const createRequest = {
  metadata: { name: "Next Test Token", ticker: "NTT", imageUrl: null, description: "Second test launch." },
  config: {
    inventoryAtoms: "600",
    reservePriceAtoms: "8",
    depositLotAtoms: "5000",
    commitWindowSeconds: 600,
    openWindowSeconds: 600,
  },
};

function createAdapter(overrides: Partial<FairLaunchCreateAdapter> = {}): FairLaunchCreateAdapter {
  return {
    async getSnapshot() { return snapshot; },
    async create() { return launch; },
    ...overrides,
  };
}

async function withServer(
  options: Parameters<typeof createSilenceServer>[0],
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createSilenceServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function localHeaders(baseUrl: string): Record<string, string> {
  return {
    "content-type": "application/json",
    origin: new URL(baseUrl).origin,
    "sec-fetch-site": "same-origin",
  };
}

test("GET launch catalog stays read-only when no create adapter is opted in", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fair-launch-catalog-"));
  const catalogPath = join(directory, "catalog.json");
  await writeFile(catalogPath, `${JSON.stringify({ version: 1, launches: [launch] })}\n`);
  try {
    await withServer({ fairLaunchCatalogPath: catalogPath }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/fair-launch/launches`);
      assert.equal(response.status, 200);
      const body = await response.json() as FairLaunchSnapshot;
      assert.equal(typeof body.live, "boolean");
      assert.equal(body.writable, false);
      assert.equal(body.network, "local-devnet");
      assert.equal(body.mode, "local-devnet-operator-demo");
      assert.deepEqual(body.capabilities, { canCreate: false });
      assert.deepEqual(body.launches, [launch]);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GET default catalog lists the recorded historical Local Devnet launch", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/fair-launch/launches`);
    assert.equal(response.status, 200);
    const body = await response.json() as { launches: FairLaunchEntry[]; capabilities: { canCreate: boolean } };
    assert.equal(body.capabilities.canCreate, false);
    assert.equal(body.launches.length, 3, "Local Devnet API must not serve the separate Preprod card");
    assert.ok(body.launches.every((entry) => entry.evidenceSource === "recorded-local-devnet-evidence" || entry.evidenceSource === "verified-local-devnet-create"));
    const historical = body.launches.filter((entry) => entry.evidenceSource === "recorded-local-devnet-evidence");
    assert.equal(historical.length, 1);
    assert.equal(historical[0]?.phase, "settled");
    assert.equal(body.launches[0]?.settlement?.clearingPriceAtoms, "10");
  });
});

test("GET launch snapshot strips fields outside the verified catalog shape", async () => {
  const taintedLaunch = { ...launch, privateSeed: "must-not-leak", creatorSecret: "hidden" } as FairLaunchEntry;
  const adapter = createAdapter({ async getSnapshot() { return { ...snapshot, launches: [taintedLaunch] }; } });
  await withServer({ fairLaunchCreateAdapter: adapter }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/fair-launch/launches`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body.includes("must-not-leak"), false);
    assert.equal(body.includes("creatorSecret"), false);
    assert.deepEqual(JSON.parse(body), snapshot);
  });
});

test("GET launch snapshot rejects an entry whose ID is not its contract address", async () => {
  const mismatched = { ...launch, id: "another-launch-id" };
  const adapter = createAdapter({ async getSnapshot() { return { ...snapshot, launches: [mismatched] }; } });
  await withServer({ fairLaunchCreateAdapter: adapter }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/fair-launch/launches`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: { code: "fair_launch_unavailable", message: "The verified launch catalog is temporarily unavailable." },
    });
  });
});

test("POST create requires same-origin loopback JSON and returns only a verified confirmed entry", async () => {
  let createCalls = 0;
  const adapter = createAdapter({
    async create(value) {
      createCalls += 1;
      assert.deepEqual(value, createRequest);
      return launch;
    },
  });

  await withServer({ fairLaunchCreateAdapter: adapter }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/fair-launch/create`, {
      method: "POST",
      headers: localHeaders(baseUrl),
      body: JSON.stringify(createRequest),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { status: "confirmed", launch });
    assert.equal(createCalls, 1);
  });
});

test("POST create fails closed if an adapter returns a historical or unverified entry", async () => {
  const historicalEntry = { ...launch, evidenceSource: "recorded-local-devnet-evidence" as const };
  await withServer({ fairLaunchCreateAdapter: createAdapter({ async create() { return historicalEntry; } }) }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/fair-launch/create`, {
      method: "POST",
      headers: localHeaders(baseUrl),
      body: JSON.stringify(createRequest),
    });
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.equal(body.includes('"status":"confirmed"'), false);
    assert.equal(body.includes("recorded-local-devnet-evidence"), false);
    assert.deepEqual(JSON.parse(body), {
      error: { code: "create_failed", message: "The launch could not be confirmed. Check the recovery status before retrying." },
    });
  });
});

test("POST create rejects a missing or cross-origin Origin before invoking the adapter", async () => {
  let createCalls = 0;
  const adapter = createAdapter({ async create() { createCalls += 1; return launch; } });
  await withServer({ fairLaunchCreateAdapter: adapter }, async (baseUrl) => {
    const missingOrigin = await fetch(`${baseUrl}/api/fair-launch/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createRequest),
    });
    assert.equal(missingOrigin.status, 403);

    const crossOrigin = await fetch(`${baseUrl}/api/fair-launch/create`, {
      method: "POST",
      headers: { ...localHeaders(baseUrl), origin: "https://attacker.example" },
      body: JSON.stringify(createRequest),
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(createCalls, 0);
  });
});

test("POST create maps strict JSON and adapter errors to controlled responses", async () => {
  const variants: Array<{
    error: Error;
    status: number;
    code: string;
  }> = [
    { error: new FairLaunchInputError(), status: 400, code: "invalid_launch" },
    { error: new FairLaunchCreateBusyError(), status: 409, code: "create_busy" },
    { error: new FairLaunchCreateUnavailableError(), status: 503, code: "create_unavailable" },
  ];
  for (const variant of variants) {
    const adapter = createAdapter({ async create() { throw variant.error; } });
    await withServer({ fairLaunchCreateAdapter: adapter }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/fair-launch/create`, {
        method: "POST",
        headers: localHeaders(baseUrl),
        body: JSON.stringify(createRequest),
      });
      assert.equal(response.status, variant.status);
      assert.equal((await response.json() as { error: { code: string } }).error.code, variant.code);
    });
  }

  await withServer({ fairLaunchCreateAdapter: createAdapter() }, async (baseUrl) => {
    const wrongContentType = await fetch(`${baseUrl}/api/fair-launch/create`, {
      method: "POST",
      headers: { ...localHeaders(baseUrl), "content-type": "text/plain" },
      body: JSON.stringify(createRequest),
    });
    assert.equal(wrongContentType.status, 415);

    const invalidJson = await fetch(`${baseUrl}/api/fair-launch/create`, {
      method: "POST",
      headers: localHeaders(baseUrl),
      body: "{not-json",
    });
    assert.equal(invalidJson.status, 400);
  });
});

test("recovery failure includes only its operation ID and never claims confirmation", async () => {
  const adapter = createAdapter({ async create() { throw new FairLaunchRecoveryRequiredError("operation-safe-id"); } });
  await withServer({ fairLaunchCreateAdapter: adapter }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/fair-launch/create`, {
      method: "POST",
      headers: localHeaders(baseUrl),
      body: JSON.stringify(createRequest),
    });
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.equal(body.includes('"status":"confirmed"'), false);
    assert.deepEqual(JSON.parse(body), {
      error: {
        code: "create_recovery_required",
        message: "A partial Local Devnet operation needs manual recovery. No retry was made.",
        operationId: "operation-safe-id",
      },
    });
  });
});

test("server without create opt-in keeps writes disabled even with a same-origin request", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/fair-launch/create`, {
      method: "POST",
      headers: localHeaders(baseUrl),
      body: JSON.stringify(createRequest),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "create_unavailable");
  });
});
