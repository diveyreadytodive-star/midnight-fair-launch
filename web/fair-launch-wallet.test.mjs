import assert from 'node:assert/strict';
import test from 'node:test';
import { assessWalletNetwork, compatibleWallets, dustLabel, initFairLaunchWallet } from './fair-launch-wallet.js';

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

test('wallet status must be connected and match Preprod in both reports', () => {
  assert.deepEqual(assessWalletNetwork({ networkId: 'preprod' }, { status: 'connected', networkId: 'preprod' }), { status: 'ready', network: 'preprod' });
  assert.deepEqual(assessWalletNetwork({ networkId: 'preprod' }, { status: 'disconnected' }), { status: 'disconnected', network: '' });
  assert.deepEqual(assessWalletNetwork({ networkId: 'preprod' }, { status: 'connected', networkId: 'preview' }), { status: 'mismatch', network: 'preview' });
  assert.deepEqual(assessWalletNetwork({}, { status: 'connected', networkId: 'preprod' }), { status: 'invalid', network: 'preprod' });
});

function fakeWalletPage(api) {
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
  const browser = { midnight: { mnLace: { name: 'Lace', apiVersion: '4.0.1', connect: async () => api } }, addEventListener() {} };
  return { doc, browser, elements };
}

test('zero-DUST connection is labeled read-only and can be refreshed', async () => {
  const api = { getConfiguration: async () => ({ networkId: 'preprod' }), getConnectionStatus: async () => ({ status: 'connected', networkId: 'preprod' }), getDustBalance: async () => 0n };
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

test('disconnected wallet never becomes a connected Fair Launch session', async () => {
  const api = { getConfiguration: async () => ({ networkId: 'preprod' }), getConnectionStatus: async () => ({ status: 'disconnected' }) };
  const { doc, browser, elements } = fakeWalletPage(api);
  const adapter = initFairLaunchWallet(doc, browser);
  await elements.walletConnect.fire();
  assert.equal(adapter.connectedApi, null);
  assert.match(elements.walletStatus.textContent, /disconnected/);
});
