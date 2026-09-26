import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildCreateRequest, canCreateFromEnvelope, deriveRecordedLaunch, isVerifiedLaunch, launchNetwork, mergeLaunches, parseRoute, phaseLabel, verifiedCatalogEntry } from './fair-launch.js';

const evidence = JSON.parse(readFileSync(new URL('./fair-launch-evidence.json', import.meta.url), 'utf8'));
const catalog = JSON.parse(readFileSync(new URL('./fair-launch-catalog.json', import.meta.url), 'utf8'));

test('Explore fallback is derived only from a settled Local Devnet record with all three setup receipts', () => {
  const launch = deriveRecordedLaunch(evidence);
  assert.ok(launch);
  assert.equal(isVerifiedLaunch(launch), true);
  assert.equal(launch.contractAddress, evidence.contractAddress);
  assert.equal(launch.phase, 'settled');
  assert.equal(launch.config.inventoryAtoms, evidence.fixture.inventoryAtoms);
  assert.equal(launch.settlement.clearingPriceAtoms, evidence.readback.clearingPriceAtoms);
  assert.equal(launch.receiptCount, evidence.receipts.length);
  assert.equal(launch.metadata.name, null);
  assert.equal(launch.metadata.ticker, null);
  assert.equal(launch.metadataAnchored, false);
});

test('unsettled or incomplete evidence cannot create an Explore card', () => {
  assert.equal(deriveRecordedLaunch({ ...evidence, readback: { ...evidence.readback, settled: false } }), null);
  assert.equal(deriveRecordedLaunch({ ...evidence, receipts: evidence.receipts.slice(1) }), null);

  const launch = deriveRecordedLaunch(evidence);
  assert.equal(isVerifiedLaunch({ ...launch, receipts: { ...launch.receipts, fund: null } }), false);
  assert.equal(isVerifiedLaunch({ ...launch, config: { ...launch.config, depositLotAtoms: null } }), false);
});

test('hash routes select Explore, Create, and a contract-specific detail view', () => {
  assert.deepEqual(parseRoute(''), { view: 'explore' });
  assert.deepEqual(parseRoute('#/explore'), { view: 'explore' });
  assert.deepEqual(parseRoute('#/create'), { view: 'create' });
  assert.deepEqual(parseRoute('#/token/abc123'), { view: 'detail', id: 'abc123' });
});

test('settled detail uses auction status language without implying a graduated token', () => {
  assert.equal(phaseLabel('settled'), 'Auction settled');
  assert.equal(phaseLabel('commit'), 'Bidding live');
  assert.equal(phaseLabel('open'), 'Opening window');
  assert.notEqual(phaseLabel('settled'), 'Graduated');
});

test('a static Preprod setup record cannot be displayed as a live bidding round', () => {
  const local = deriveRecordedLaunch(evidence);
  const preprod = {
    ...local, network: 'preprod', phase: 'commit', metadataAnchored: true,
    evidenceSource: 'verified-preprod-create', metadataCommitmentHex: 'a'.repeat(64),
    commitDeadlineUnixSeconds: '1790500000', openDeadlineUnixSeconds: '1790503600',
  };
  assert.equal(isVerifiedLaunch(preprod), true);
  assert.equal(launchNetwork(preprod), 'preprod');
  assert.equal(verifiedCatalogEntry(preprod).phase, 'unknown');
  assert.equal(verifiedCatalogEntry(preprod).settlement, null);
  assert.equal(verifiedCatalogEntry(preprod).registeredBidCount, null);
  assert.equal(mergeLaunches([local], [verifiedCatalogEntry(preprod)]).length, 2, 'the same hex address on two networks must not merge');
  assert.equal(phaseLabel('unknown'), 'Current status not verified');
  assert.equal(isVerifiedLaunch({ ...preprod, metadataAnchored: false }), false);
  assert.equal(isVerifiedLaunch({ ...preprod, evidenceSource: 'recorded-local-devnet-evidence' }), false);
  assert.equal(isVerifiedLaunch({ ...preprod, network: 'mainnet' }), false);
  assert.equal(launchNetwork(local), 'local-devnet');
});

test('the independently verified Preprod setup has all three receipt references but no invented live phase', () => {
  const preprod = catalog.launches.find((entry) => entry.network === 'preprod');
  assert.ok(preprod);
  assert.equal(preprod.evidenceSource, 'verified-preprod-create');
  assert.equal(isVerifiedLaunch(preprod), true);
  assert.deepEqual(Object.keys(preprod.receipts).sort(), ['deploy', 'fund', 'mint']);
  assert.equal(verifiedCatalogEntry(preprod).phase, 'unknown');
  assert.equal(verifiedCatalogEntry(preprod).registeredBidCount, null);
});

test('Create is available only in the explicitly writable operator-sponsored Local Devnet mode', () => {
  const envelope = { live: true, writable: true, network: 'local-devnet', mode: 'local-devnet-operator-demo', capabilities: { canCreate: true } };
  assert.equal(canCreateFromEnvelope(envelope), true);
  assert.equal(canCreateFromEnvelope({ ...envelope, writable: false }), false);
  assert.equal(canCreateFromEnvelope({ ...envelope, mode: 'production' }), false);
  assert.equal(canCreateFromEnvelope({ ...envelope, capabilities: { canCreate: false } }), false);
});

test('Create request uses the backend metadata/config schema and converts minutes to seconds', () => {
  const result = buildCreateRequest({
    name: 'Test launch',
    ticker: 'demo',
    imageUrl: 'https://example.com/token.png',
    description: 'Local test only',
    inventoryAtoms: '600',
    reservePriceAtoms: '8',
    depositLotAtoms: '5000',
    commitWindowMinutes: '5',
    openWindowMinutes: '60',
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.payload, {
    metadata: { name: 'Test launch', ticker: 'DEMO', imageUrl: 'https://example.com/token.png', description: 'Local test only' },
    config: { inventoryAtoms: '600', reservePriceAtoms: '8', depositLotAtoms: '5000', commitWindowSeconds: 300, openWindowSeconds: 3600 },
  });
  assert.ok(buildCreateRequest({ name: 'Test', ticker: 'TEST', imageUrl: 'http://example.com/x.png', inventoryAtoms: 600, reservePriceAtoms: 8, depositLotAtoms: 5000, commitWindowMinutes: 5, openWindowMinutes: 60 }).errors.length > 0);
});

test('Create validation follows the selected English locale', () => {
  const result = buildCreateRequest({
    name: '', ticker: 'BAD TICKER', imageUrl: 'http://example.com/x.png', description: '',
    inventoryAtoms: '0', reservePriceAtoms: '', depositLotAtoms: '5000', commitWindowMinutes: '1', openWindowMinutes: '60',
  }, 'en');
  assert.ok(result.errors.some((error) => error.includes('Enter a token name')));
  assert.ok(result.errors.some((error) => error.includes('Image URL must use HTTPS')));
  assert.ok(result.errors.some((error) => error.includes('Commit window must be at least 5 minutes')));
  assert.equal(result.errors.some((error) => /[가-힣]/.test(error)), false);
});

test('the UI exposes read-only evidence and keeps wallet actions disabled in markup', () => {
  const html = readFileSync(new URL('./fair-launch.html', import.meta.url), 'utf8');
  assert.match(html, /id="launchSearch"/);
  assert.match(html, /href="#\/create"/);
  assert.match(html, /id="detailBidButton"[^>]*disabled/);
  assert.match(html, /id="detailTokenClaimButton"[^>]*disabled/);
  assert.match(html, /id="detailRefundClaimButton"[^>]*disabled/);
  assert.match(html, /fair-launch-evidence\.json/);
  assert.match(html, /proof-asset-check\.html/);
});
