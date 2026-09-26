const API_V4 = /^4\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const SPECKS_PER_DUST = 1_000_000_000_000_000n;

export function compatibleWallets(registry) {
  if (!registry || typeof registry !== 'object') return [];
  return Object.entries(registry).flatMap(([key, provider]) => {
    try {
      if (!provider || !API_V4.test(String(provider.apiVersion ?? '')) || typeof provider.connect !== 'function') return [];
      const name = String(provider.name ?? key);
      const rdns = String(provider.rdns ?? '');
      const recognized = /lace|1am/i.test(`${key} ${name} ${rdns}`);
      return recognized ? [{ key, name, rdns, provider }] : [];
    } catch { return []; }
  });
}

export function dustLabel(balance, language = 'en') {
  const value = typeof balance === 'bigint' ? balance : BigInt(balance);
  if (value < 0n) throw new RangeError('Negative DUST balance');
  const whole = value / SPECKS_PER_DUST;
  const fraction = (value % SPECKS_PER_DUST).toString().padStart(15, '0').replace(/0+$/, '').slice(0, 6);
  return `${new Intl.NumberFormat(language === 'ko' ? 'ko-KR' : 'en-US').format(whole)}${fraction ? `.${fraction}` : ''} tDUST`;
}

const messages = {
  en: {
    open: 'Connect wallet', connected: 'Wallet connected · read only', missing: 'No compatible Lace or 1AM wallet was detected. Install a Preprod wallet and scan again.',
    found: 'Select a compatible wallet. Connecting requests wallet permission but no transaction or signature.',
    scanning: 'Scan again', connect: 'Connect selected wallet', connecting: 'Waiting for wallet approval…',
    mismatch: 'Wallet network mismatch. This page requires Preprod.',
    ready: 'Preprod wallet connected. This panel reads DUST balance only; bids and claims remain unavailable.',
    unavailable: 'DUST balance unavailable. Check wallet permissions and connection.',
    rejected: 'Wallet connection was cancelled or permission was denied.',
    invalid: 'Wallet did not provide the expected network status.',
  },
  ko: {
    open: '지갑 연결', connected: '지갑 연결됨 · 읽기 전용', missing: '호환되는 Lace 또는 1AM 지갑을 찾지 못했습니다. Preprod 지갑을 설치한 뒤 다시 확인하세요.',
    found: '지갑을 선택하세요. 연결 권한만 요청하며 서명이나 거래는 요청하지 않습니다.',
    scanning: '다시 검색', connect: '선택한 지갑 연결', connecting: '지갑 승인 대기 중…',
    mismatch: '지갑 네트워크가 맞지 않습니다. 이 페이지는 Preprod를 사용합니다.',
    ready: 'Preprod 지갑에 연결했습니다. DUST 잔액만 읽으며 입찰·청구는 아직 사용할 수 없습니다.',
    unavailable: 'DUST 잔액을 읽지 못했습니다. 지갑 권한과 연결 상태를 확인하세요.',
    rejected: '지갑 연결을 취소했거나 권한을 거부했습니다.',
    invalid: '지갑이 필요한 네트워크 상태를 반환하지 않았습니다.',
  },
};

export function initFairLaunchWallet(doc = document, browser = window) {
  const $ = (selector) => doc.querySelector(selector);
  const state = { providers: [], api: null, connecting: false, network: '', dust: null, status: 'open' };
  const language = () => doc.documentElement.lang === 'ko' ? 'ko' : 'en';
  const message = (key) => messages[language()][key];

  function render() {
    $('#walletButton').textContent = message(state.api && state.network === 'preprod' ? 'connected' : 'open');
    $('#walletStatus').textContent = message(state.status);
    $('#walletConnect').textContent = state.providers.length ? message('connect') : message('scanning');
    $('#walletConnect').disabled = state.connecting || Boolean(state.api && state.network === 'preprod');
    $('#walletReadout').hidden = state.dust == null || state.network !== 'preprod';
    if (state.dust != null && state.network === 'preprod') $('#walletDust').textContent = dustLabel(state.dust, language());
    $('#walletNetwork').textContent = state.network || '—';
  }

  function scan() {
    let registry;
    try { registry = browser.midnight; } catch { registry = null; }
    state.providers = compatibleWallets(registry);
    const select = $('#walletProvider');
    select.replaceChildren();
    for (const [index, item] of state.providers.entries()) {
      const option = doc.createElement('option');
      option.value = String(index);
      option.textContent = `${item.name} · API ${item.provider.apiVersion}`;
      select.append(option);
    }
    select.hidden = state.providers.length < 2;
    state.status = state.providers.length ? 'found' : 'missing';
    if (state.api && state.network === 'preprod') state.status = state.dust == null ? 'unavailable' : 'ready';
    render();
  }

  async function connect() {
    if (state.connecting || state.api) return;
    if (!state.providers.length) { scan(); return; }
    const selected = state.providers[Number($('#walletProvider').value || 0)];
    if (!selected) return;
    state.connecting = true;
    state.status = 'connecting';
    render();
    try {
      const api = await selected.provider.connect('preprod');
      if (!api || typeof api.getConfiguration !== 'function' || typeof api.getConnectionStatus !== 'function') {
        state.status = 'invalid'; return;
      }
      const [configuration, connection] = await Promise.all([api.getConfiguration(), api.getConnectionStatus()]);
      const configured = String(configuration?.networkId ?? '').toLowerCase();
      const actual = String(connection?.networkId ?? configured).toLowerCase();
      state.network = actual || configured;
      if (configured && actual && configured !== actual) state.status = 'mismatch';
      else if (state.network !== 'preprod') state.status = 'mismatch';
      else {
        state.api = api;
        try {
          state.dust = await api.getDustBalance();
          dustLabel(state.dust);
          state.status = 'ready';
        } catch { state.status = 'unavailable'; }
      }
    } catch { state.status = 'rejected'; }
    finally { state.connecting = false; render(); }
  }

  $('#walletButton').addEventListener('click', () => {
    const panel = $('#walletPanel');
    panel.hidden = !panel.hidden;
    $('#walletButton').setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) scan();
  });
  $('#walletConnect').addEventListener('click', connect);
  $('#walletClose').addEventListener('click', () => {
    $('#walletPanel').hidden = true;
    $('#walletButton').setAttribute('aria-expanded', 'false');
  });
  $('#localeToggle').addEventListener('click', () => queueMicrotask(render));
  browser.addEventListener?.('midnight#ready', scan);
  scan();
  return { get connectedApi() { return state.api; }, scan };
}
