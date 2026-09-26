import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createSilenceServer,
  type MarketView,
  type ObserverView,
  type SilenceDataProvider,
  type SilenceServerOptions,
} from "../../src/api/http-server.ts";

const oracle = {
  price: "64123.45",
  sequence: 42,
  updatedAt: "2026-09-26T00:00:00.000Z",
  source: "demo" as const,
};

const market: MarketView = {
  market: "BTC-USD",
  markPrice: "64123.450",
  oracle,
  policy: {
    fixedCollateralLot: "1000",
    maxLeverageBps: 30_000,
    maintenanceMarginBps: 1_000,
    estimatedExitCost: "20",
    profitPayoutCap: "500",
    riskSlotLiability: "500",
    availableRiskReserve: "1000",
  },
};

const observer: ObserverView = {
  oracle,
  policyVersion: "policy-v1",
  occupiedRiskSlots: 2,
  fixedCollateralLot: "1000",
};

function createProvider(overrides: Partial<SilenceDataProvider> = {}): SilenceDataProvider {
  return {
    async readMarket() { return market; },
    async readCandles() { return []; },
    async readObserver() { return observer; },
    ...overrides,
  };
}

async function withServer<T>(
  options: SilenceServerOptions,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
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

function rawGet(url: URL, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: url.hostname,
      port: Number(url.port),
      method: "GET",
      path,
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("serves an allowlisted public market shape from the injected data provider", async () => {
  await withServer({ dataProvider: createProvider() }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/market/BTC-USD`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(await response.json(), {
      market: "BTC-USD",
      markPrice: "64123.450",
      oracle,
      policy: {
        fixedCollateralLot: "1000",
        maxLeverageBps: 30_000,
        maintenanceMarginBps: 1_000,
        estimatedExitCost: "20",
        profitPayoutCap: "500",
        riskSlotLiability: "500",
        availableRiskReserve: "1000",
      },
    });
  });
});

test("observer output allowlists aggregate public fields and strips nested private fields", async () => {
  const leakingObserver = {
    ...observer,
    side: "long",
    notional: "5000",
    positions: [{ owner: "private-wallet-1", guardBuffer: "225" }],
    nested: { entryPrice: "100" },
  } as unknown as ObserverView;
  await withServer({ dataProvider: createProvider({ async readObserver() { return leakingObserver; } }) }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/observer/market/BTC-USD`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), {
      oracle,
      policyVersion: "policy-v1",
      occupiedRiskSlots: 2,
      fixedCollateralLot: "1000",
    });
    for (const privateValue of ["private-wallet-1", "guardBuffer", "entryPrice", "notional", "side", "positions"]) {
      assert.equal(body.includes(privateValue), false);
    }
  });
});

test("returns safe 503 JSON when no real data provider is configured", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/market/BTC-USD`);
    assert.equal(response.status, 503);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(await response.json(), {
      error: { code: "market_unavailable", message: "The market data is temporarily unavailable." },
    });
  });
});

test("denies private positions and open requests without verified wallet auth", async () => {
  const provider = createProvider({
    async readPrivatePositions() { throw new Error("must not read unauthenticated positions"); },
  });
  await withServer({ dataProvider: provider }, async (baseUrl) => {
    const positions = await fetch(`${baseUrl}/api/v1/private/positions`);
    assert.equal(positions.status, 401);
    assert.deepEqual(await positions.json(), {
      error: { code: "wallet_auth_required", message: "Connect an authenticated test wallet to view private positions." },
    });

    const open = await fetch(`${baseUrl}/api/v1/private/positions/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ market: "BTC-USD", side: "long", notional: "3000", leverage: "3", guardBuffer: "225" }),
    });
    assert.equal(open.status, 401);
    assert.deepEqual(await open.json(), {
      error: { code: "wallet_auth_required", message: "Connect an authenticated test wallet to open a position." },
    });
  });
});

test("keeps open requests unavailable when auth exists but Compact and chain adapter is absent", async () => {
  await withServer({
    dataProvider: createProvider(),
    walletAuthenticator: { async authenticateOwner() { return { ownerId: "wallet-private-1" }; } },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/private/positions/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ market: "BTC-USD", side: "long", notional: "5000", leverage: "5", guardBuffer: "225" }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: { code: "trading_not_ready", message: "Wallet authorization, Compact proof, and chain readback are not configured." },
    });
  });
});

test("rejects browser collateral overrides before invoking the real operation adapter", async () => {
  let openCalls = 0;
  await withServer({
    dataProvider: createProvider(),
    walletAuthenticator: { async authenticateOwner() { return { ownerId: "wallet-private-1" }; } },
    openAdapter: {
      async openPosition() {
        openCalls += 1;
        return { operationId: "op-1", state: "pending" };
      },
      async readOperation() { return null; },
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/private/positions/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ market: "BTC-USD", side: "long", notional: "3000", leverage: "3", guardBuffer: "225", collateral: "1" }),
    });
    assert.equal(response.status, 400);
    assert.equal(openCalls, 0);
  });
});

test("enforces positive guard-buffer atoms through the fixed 1000-unit maximum", async () => {
  let openCalls = 0;
  const receivedBuffers: string[] = [];
  await withServer({
    dataProvider: createProvider(),
    walletAuthenticator: { async authenticateOwner() { return { ownerId: "wallet-private-1" }; } },
    openAdapter: {
      async openPosition(_owner, intent) {
        openCalls += 1;
        receivedBuffers.push(intent.guardBuffer);
        return { operationId: `op-${openCalls}`, state: "pending" };
      },
      async readOperation() { return null; },
    },
  }, async (baseUrl) => {
    const sendOpen = (guardBuffer: string) => fetch(`${baseUrl}/api/v1/private/positions/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ market: "BTC-USD", side: "long", notional: "3000", leverage: "3", guardBuffer }),
    });

    assert.equal((await sendOpen("0")).status, 400);
    assert.equal((await sendOpen("1000.000001")).status, 400);
    assert.equal(openCalls, 0);

    const maximum = await sendOpen("1000");
    assert.equal(maximum.status, 202);
    assert.equal(openCalls, 1);
    assert.deepEqual(receivedBuffers, ["1000"]);
  });
});

test("rejects an external reference oracle for open requests before invoking the adapter", async () => {
  let openCalls = 0;
  const externalOracleProvider = createProvider({
    async readMarket() {
      return { ...market, oracle: { ...oracle, source: "external" } };
    },
  });
  await withServer({
    dataProvider: externalOracleProvider,
    walletAuthenticator: { async authenticateOwner() { return { ownerId: "wallet-private-1" }; } },
    openAdapter: {
      async openPosition() {
        openCalls += 1;
        return { operationId: "must-not-run", state: "pending" };
      },
      async readOperation() { return null; },
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/private/positions/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ market: "BTC-USD", side: "long", notional: "3000", leverage: "3", guardBuffer: "225" }),
    });
    assert.equal(response.status, 503);
    assert.equal(openCalls, 0);
    assert.deepEqual(await response.json(), {
      error: { code: "trading_not_ready", message: "Open requests require the accepted permissioned demo oracle." },
    });
  });
});

test("does not expose confirmed state without chain receipt and required state readback", async () => {
  await withServer({
    dataProvider: createProvider(),
    walletAuthenticator: { async authenticateOwner() { return { ownerId: "wallet-private-1" }; } },
    openAdapter: {
      async openPosition() {
        return { operationId: "op-fake-confirmed", state: "confirmed", txHash: "0x1234567890abcdef" };
      },
      async readOperation() { return null; },
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/private/positions/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ market: "BTC-USD", side: "long", notional: "3000", leverage: "3", guardBuffer: "225" }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes("confirmed"), false);
  });
});

test("operation polling requires the private owner capability and scopes reads to that owner", async () => {
  let operationReads = 0;
  const openAdapter = {
    async openPosition() { return { operationId: "unused", state: "pending" as const }; },
    async readOperation(owner: { readonly ownerId: string }, operationId: string) {
      operationReads += 1;
      assert.equal(owner.ownerId, "wallet-private-1");
      assert.equal(operationId, "op-private-1");
      return { operationId, state: "pending" as const };
    },
  };

  await withServer({ openAdapter }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/operations/op-private-1`);
    assert.equal(response.status, 401);
    assert.equal(operationReads, 0);
  });

  await withServer({
    openAdapter,
    walletAuthenticator: { async authenticateOwner() { return { ownerId: "wallet-private-1" }; } },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/operations/op-private-1`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { operationId: "op-private-1", state: "pending" });
    assert.equal(operationReads, 1);
  });
});

test("fails closed when the operation adapter returns a different ID than the requested one", async () => {
  await withServer({
    walletAuthenticator: { async authenticateOwner() { return { ownerId: "wallet-private-1" }; } },
    openAdapter: {
      async openPosition() { return { operationId: "unused", state: "pending" as const }; },
      async readOperation(_owner, operationId) {
        assert.equal(operationId, "op-a");
        return { operationId: "op-other-owner", state: "submitted" as const, txHash: "0x1234567890abcdef" };
      },
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/operations/op-a`);
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.equal(body.includes("op-other-owner"), false);
    assert.equal(body.includes("0x1234567890abcdef"), false);
  });
});

test("rejects path traversal and serves static files with safe content types", async () => {
  const directory = await mkdtemp(join(tmpdir(), "silence-api-static-"));
  const webRoot = join(directory, "web");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>SILENCE</title>");
  await writeFile(join(webRoot, "app.js"), "export const safe = true;");
  await writeFile(join(webRoot, "style.css"), "body { color: black; }");
  await writeFile(join(directory, "secret.txt"), "must-not-escape-web-root");
  try {
    await withServer({ webRoot }, async (baseUrl) => {
      const html = await fetch(baseUrl);
      assert.equal(html.status, 200);
      assert.match(html.headers.get("content-type") ?? "", /^text\/html/);
      assert.match(await html.text(), /SILENCE/);

      const script = await fetch(`${baseUrl}/app.js`);
      assert.match(script.headers.get("content-type") ?? "", /^text\/javascript/);
      const css = await fetch(`${baseUrl}/style.css`);
      assert.match(css.headers.get("content-type") ?? "", /^text\/css/);

      const traversal = await rawGet(new URL(baseUrl), "/%2e%2e/secret.txt");
      assert.ok(traversal.status === 400 || traversal.status === 404);
      assert.equal(traversal.body.includes("must-not-escape-web-root"), false);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serves candles as empty only from a configured provider with no accepted history", async () => {
  await withServer({ dataProvider: createProvider() }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/market/BTC-USD/candles?interval=1h&limit=120`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { candles: [] });
  });
});
