import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  appendFairLaunchCatalogEntry,
  assertLocalDevnetEndpoints,
  createFairLaunchCreateAdapter,
  DEFAULT_FAIR_LAUNCH_CATALOG,
  fairLaunchMetadataCommitment,
  readFairLaunchCatalog,
  validateFairLaunchCreateRequest,
  type FairLaunchEntry,
} from '../../../src/api/fair-launch-create.ts';

const validRequest = {
  metadata: {
    name: 'Example Token',
    ticker: 'exm',
    imageUrl: 'https://assets.example.test/token.png',
    description: 'A local demonstration token.',
  },
  config: {
    inventoryAtoms: '600',
    reservePriceAtoms: '8',
    depositLotAtoms: '5000',
    commitWindowSeconds: 480,
    openWindowSeconds: 3600,
  },
};

const verifiedEntry: FairLaunchEntry = {
  id: 'ab'.repeat(32),
  contractAddress: 'ab'.repeat(32),
  metadata: { name: 'Example Token', ticker: 'EXM', imageUrl: 'https://assets.example.test/token.png', description: 'A local demonstration token.' },
  config: { ...validRequest.config },
  phase: 'commit',
  createdAt: '2026-09-26T13:00:00.000Z',
  commitDeadlineUnixSeconds: '1790432400',
  openDeadlineUnixSeconds: '1790436000',
  metadataAnchored: true,
  metadataCommitmentHex: 'cd'.repeat(32),
  artworkBytesAnchored: false,
  evidenceSource: 'verified-local-devnet-create',
  receipts: {
    deploy: { txId: '01'.repeat(33), transactionHash: '02'.repeat(32), blockHeight: 10 },
    mint: { txId: '03'.repeat(33), transactionHash: '04'.repeat(32), blockHeight: 11 },
    fund: { txId: '05'.repeat(33), transactionHash: '06'.repeat(32), blockHeight: 12 },
  },
};

test('Local Devnet Create snapshot excludes the independent Preprod catalog entry', async () => {
  const adapter = createFairLaunchCreateAdapter({
    catalogPath: DEFAULT_FAIR_LAUNCH_CATALOG,
    enabled: () => false,
    probe: async () => false,
  });
  const snapshot = await adapter.getSnapshot();
  assert.equal(snapshot.network, 'local-devnet');
  assert.equal((await readFairLaunchCatalog(DEFAULT_FAIR_LAUNCH_CATALOG)).length, 4);
  assert.equal(snapshot.launches.length, 3);
});

test('validates launch form fields and canonicalizes ticker and image URL', () => {
  const input = validateFairLaunchCreateRequest(validRequest);
  assert.equal(input.metadata.ticker, 'EXM');
  assert.equal(input.metadata.imageUrl, 'https://assets.example.test/token.png');
  assert.equal(input.config.inventoryAtoms, '600');
  assert.equal(input.config.commitWindowSeconds, 480);
  assert.match(fairLaunchMetadataCommitment(input), /^[0-9a-f]{64}$/);
  assert.notEqual(
    fairLaunchMetadataCommitment(input),
    fairLaunchMetadataCommitment(validateFairLaunchCreateRequest({
      ...validRequest,
      metadata: { ...validRequest.metadata, description: 'Changed metadata.' },
    })),
  );
});

test('revalidates a canonical request with no image across the server and runner boundary', () => {
  const first = validateFairLaunchCreateRequest({
    ...validRequest,
    metadata: { ...validRequest.metadata, imageUrl: '' },
  });
  assert.equal(first.metadata.imageUrl, null);
  assert.deepEqual(validateFairLaunchCreateRequest(first), first);
});

test('rejects unsafe, malformed, underfunded, or too-short auction configurations', () => {
  assert.throws(() => validateFairLaunchCreateRequest({
    ...validRequest,
    metadata: { ...validRequest.metadata, imageUrl: 'http://127.0.0.1/private' },
  }));
  assert.throws(() => validateFairLaunchCreateRequest({
    ...validRequest,
    metadata: { ...validRequest.metadata, imageUrl: 'https://user:pass@example.test/image.png' },
  }));
  assert.throws(() => validateFairLaunchCreateRequest({
    ...validRequest,
    config: { ...validRequest.config, inventoryAtoms: '18446744073709551616' },
  }));
  assert.throws(() => validateFairLaunchCreateRequest({
    ...validRequest,
    config: { ...validRequest.config, depositLotAtoms: '100' },
  }));
  assert.throws(() => validateFairLaunchCreateRequest({
    ...validRequest,
    config: { ...validRequest.config, commitWindowSeconds: 60 },
  }));
});

test('refuses non-loopback and non-canonical network endpoints', () => {
  assert.throws(() => assertLocalDevnetEndpoints({
    indexer: 'https://preprod.example/api/v4/graphql',
    indexerWS: 'wss://preprod.example/api/v4/graphql/ws',
    node: 'wss://preprod.example/',
    proofServer: 'https://preprod.example/',
  }));
  assert.throws(() => assertLocalDevnetEndpoints({
    indexer: 'http://127.0.0.1:28088/api/v4/graphql?forward=1',
    indexerWS: 'ws://127.0.0.1:28088/api/v4/graphql/ws',
    node: 'ws://127.0.0.1:29944/',
    proofServer: 'http://127.0.0.1:26300/',
  }));
});

test('appends only distinct verified contract entries and reads back the atomic catalog', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fair-launch-catalog-'));
  const path = join(directory, 'catalog.json');
  try {
    await writeFile(path, `${JSON.stringify({ version: 1, launches: [] })}\n`, 'utf8');
    await appendFairLaunchCatalogEntry(verifiedEntry, path);
    assert.deepEqual(await readFairLaunchCatalog(path), [verifiedEntry]);
    await assert.rejects(appendFairLaunchCatalogEntry(verifiedEntry, path), /already present/);
    const persisted = JSON.parse(await readFile(path, 'utf8')) as { version: number; launches: unknown[] };
    assert.equal(persisted.version, 1);
    assert.equal(persisted.launches.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Explore catalog retains the evidence-backed historical Local Devnet contract', async () => {
  const launches = await readFairLaunchCatalog(DEFAULT_FAIR_LAUNCH_CATALOG);
  const evidence = JSON.parse(await readFile(new URL('../docs/evidence/local-devnet-fair-launch.json', import.meta.url), 'utf8')) as {
    readonly contractAddress: string;
    readonly checkedAt: string;
    readonly receipts: readonly { readonly stage: string; readonly txId: string; readonly transactionHash: string; readonly blockHeight: number }[];
    readonly readback: { readonly settled: boolean; readonly clearingPriceAtoms: string; readonly allocationsAtoms: readonly string[]; readonly refundsAtoms: readonly string[]; readonly tokenClaimed: readonly boolean[]; readonly refundClaimed: readonly boolean[] };
  };
  assert.equal(launches.filter((entry) => entry.contractAddress === evidence.contractAddress).length, 1);
  const launch = launches.find((entry) => entry.contractAddress === evidence.contractAddress);
  assert.ok(launch);
  assert.equal(launch.contractAddress, evidence.contractAddress);
  assert.equal(launch.metadata.name, null);
  assert.equal(launch.metadata.ticker, null);
  assert.equal(launch.metadataAnchored, false);
  assert.equal(launch.phase, 'settled');
  assert.equal(launch.createdAt, evidence.checkedAt);
  for (const [key, stage] of [['deploy', 'deploy'], ['mint', 'mint-sale-inventory'], ['fund', 'fund-contract-inventory']] as const) {
    const recorded = evidence.receipts.find((receipt) => receipt.stage === stage);
    assert.ok(recorded);
    assert.deepEqual(launch.receipts[key], {
      txId: recorded.txId,
      transactionHash: recorded.transactionHash,
      blockHeight: recorded.blockHeight,
    });
  }
  assert.deepEqual(launch.settlement, {
    clearingPriceAtoms: evidence.readback.clearingPriceAtoms,
    allocationsAtoms: evidence.readback.allocationsAtoms,
    refundsAtoms: evidence.readback.refundsAtoms,
    tokenClaimed: evidence.readback.tokenClaimed,
    refundClaimed: evidence.readback.refundClaimed,
  });
});
