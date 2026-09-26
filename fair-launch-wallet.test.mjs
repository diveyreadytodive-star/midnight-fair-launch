import assert from 'node:assert/strict';
import test from 'node:test';
import { assessWalletNetwork, compatibleWallets, dustBalanceValue, dustLabel, hasDuplicateWalletIdentity, initFairLaunchWallet } from './fair-launch-wallet.js';

test('only recognized API v4 wallet providers are offered', () => {
  const connect = async () => ({});
  const found = compatibleWallets({ mnLace: { name: 'Lace', apiVersion: '4.0.1', connect }, fake: { name: 'Unknown', apiVersion: '4.0.1', connect }, oldLace: { name: 'Lace', apiVersion: '3.0.0', connect } });
  assert.equal(found.length, 1);
  assert.equal(found[0].key, 'mnLace');
});

test('DUST display uses exact integer units', () => {
  assert.equal(dustLabel(1_000_000_000_000_000n), '1 tDUST');
  assert.equal(dustLabel(1_500_000_000_000_000n), '1.5 tDUST');
  assert.throws(() => dustLabel(-1n), RangeError);
});

test('DApp Connector v4 DUST report reads its balance field', () => {
  assert.equal(dustBalanceValue({ cap: 2_000_000_000_000_000n, balance: 1_000_000_000_000_000n }), 1_000_000_000_000_000n);
  assert.throws(() => dustBalanceValue({ cap: 1n }), TypeError);
});

test('wallet status must be connected and match Preprod in both reports', () => {
  assert.deepEqual(assessWalletNetwork({ networkId: 'preprod' }, { status: 'connected', networkId: 'preprod' }), { status: 'ready', network: 'preprod' });
  assert.deepEqual(assessWalletNetwork({ networkId: 'preprod' }, { status: 'disconnected' }), { status: 'disconnected', network: '' });
  assert.deepEqual(assessWalletNetwork({ networkId: 'preprod' }, { status: 'connected', networkId: 'preview' }), { status: 'mismatch', network: 'preview' });
  assert.deepEqual(assessWalletNetwork({}, { status: 'connected', networkId: 'preprod' }), { status: 'invalid', network: 'preprod' });
});

test('duplicate claimed wallet identities are detected without blocking distinct providers', () => {
  assert.equal(hasDuplicateWalletIdentity([{ rdns: 'io.lace' }, { rdns: 'IO.LACE' }]), true);
  assert.equal(hasDuplicateWalletIdentity([{ rdns: 'io.lace' }, { rdns: 'xyz.1am' }]), false);
  assert.equal(hasDuplicateWalletIdentity([{ rdns: '' }, { rdns: '' }]), false);
});

function fakeWalletPage(api, providers) {
  const ids = ['walletButton', 'walletStatus', 'walletConnect', 'walletReadout', 'walletDust', 'walletNetwork', 'walletProvider', 'walletPanel', 'walletClose', 'localeToggle'];
  const elements = Object.fromEntries(ids.map((id) => [id, {
    hidden: id === 'walletPanel' || id === 'walletReadout',
    value: '', handlers: {},
    addEventListener(name, handler) { this.handlers[name] = handler; },
    setAttribute(name, value) { this[name] = value; },
    replaceChildren() { this.children = []; },
    append(child) { (this.children ??= []).push(child); },
    async fire(name = 'click') { return this.handlers[name]?.(); },
  }]));
  const doc = { documentElement: { lang: 'en' }, querySelector: (selector) => elements[selector.slice(1)], createElement: () => ({}) };
  const browser = { midnight: providers ?? { mnLace: { name: 'Lace', apiVersion: '4.0.1', connect: async () => api } }, addEventListener() {} };
  return { doc, browser, elements };
}

test('zero-DUST connection is labeled read-only and can be refreshed', async () => {
  const api = { getConfiguration: async () => ({ networkId: 'preprod' }), getConnectionStatus: async () => ({ status: 'connected', networkId: 'preprod' }), getDustBalance: async () => ({ cap: 0n, balance: 0n }) };
  const { doc, browser, elements } = fakeWalletPage(api);
  const adapter = initFairLaunchWallet(doc, browser);
  await elements.walletButton.fire();
  await elements.walletConnect.fire();
  assert.equal(adapter.connectedApi, api);
  assert.equal(elements.walletReadout.hidden, false);
  assert.match(elements.walletStatus.textContent, /0 tDUST/);
  assert.equal(elements.walletDust.textContent, '0 tDUST');
  assert.equal(elements.walletConnect.textContent, 'Refresh DUST');
  await elements.walletConnect.fire();
  assert.equal(elements.walletDust.textContent, '0 tDUST');
});

test('duplicate injected wallet identities disable the connection button', async () => {
  const connect = async () => { throw new Error('must not connect'); };
  const providers = { mnLace: { name: 'Lace', rdns: 'io.lace', apiVersion: '4.0.1', connect }, fakeLace: { name: 'Lace', rdns: 'io.lace', apiVersion: '4.0.1', connect } };
  const { doc, browser, elements } = fakeWalletPage(null, providers);
  initFairLaunchWallet(doc, browser);
  assert.equal(elements.walletConnect.disabled, true);
  assert.match(elements.walletStatus.textContent, /same identity/);
  await elements.walletConnect.fire();
  assert.equal(elements.walletReadout.hidden, true);
});

test('a newly injected duplicate clears an earlier read-only connection', async () => {
  const api = { getConfiguration: async () => ({ networkId: 'preprod' }), getConnectionStatus: async () => ({ status: 'connected', networkId: 'preprod' }), getDustBalance: async () => 1n };
  const { doc, browser, elements } = fakeWalletPage(api, { mnLace: { name: 'Lace', rdns: 'io.lace', apiVersion: '4.0.1', connect: async () => api } });
  const adapter = initFairLaunchWallet(doc, browser);
  await elements.walletConnect.fire();
  assert.equal(adapter.connectedApi, api);
  browser.midnight.fakeLace = { name: 'Lace', rdns: 'io.lace', apiVersion: '4.0.1', connect: async () => api };
  adapter.scan();
  assert.equal(adapter.connectedApi, null);
  assert.equal(elements.walletReadout.hidden, true);
  assert.match(elements.walletStatus.textContent, /same identity/);
});

test('disconnected wallet never becomes a connected Fair Launch session', async () => {
  const api = { getConfiguration: async () => ({ networkId: 'preprod' }), getConnectionStatus: async () => ({ status: 'disconnected' }) };
  const { doc, browser, elements } = fakeWalletPage(api);
  const adapter = initFairLaunchWallet(doc, browser);
  await elements.walletConnect.fire();
  assert.equal(adapter.connectedApi, null);
  assert.match(elements.walletStatus.textContent, /disconnected/);
});

test('refresh clears a connection after the wallet switches away from Preprod', async () => {
  let network = 'preprod';
  const api = { getConfiguration: async () => ({ networkId: network }), getConnectionStatus: async () => ({ status: 'connected', networkId: network }), getDustBalance: async () => 1_000_000_000_000_000n };
  const { doc, browser, elements } = fakeWalletPage(api);
  const adapter = initFairLaunchWallet(doc, browser);
  await elements.walletConnect.fire();
  assert.equal(adapter.connectedApi, api);
  network = 'preview';
  await elements.walletConnect.fire();
  assert.equal(adapter.connectedApi, null);
  assert.match(elements.walletStatus.textContent, /requires Preprod/);
  assert.equal(elements.walletReadout.hidden, true);
});
