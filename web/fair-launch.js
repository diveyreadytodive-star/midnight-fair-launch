import { createLocaleController } from './fair-launch-locale.js';
import { initFairLaunchWallet } from './fair-launch-wallet.js';

const LAUNCHES_URL = '/api/fair-launch/launches';
const CREATE_URL = '/api/fair-launch/create';
const RECORDED_EVIDENCE_URL = './fair-launch-evidence.json';
const RECORDED_CATALOG_URL = './fair-launch-catalog.json';
const CREATE_MODE = 'local-devnet-operator-demo';
const ALLOWED_PHASES = new Set(['upcoming', 'commit', 'open', 'settling', 'settled', 'cancelled', 'unknown']);

/*
 * GET /api/fair-launch/launches returns the Local Devnet capability envelope
 * and only verified entries. POST /api/fair-launch/create accepts metadata
 * plus integer atom config; the localhost operator signs test mint/funding.
 */

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validReceipt(receipt) {
  return Boolean(
    receipt &&
    nonEmpty(receipt.txId) &&
    nonEmpty(receipt.transactionHash) &&
    Number.isInteger(Number(receipt.blockHeight)),
  );
}

function positiveInteger(value) {
  return /^(?:[1-9]\d*)$/.test(String(value ?? ''));
}

export function canCreateFromEnvelope(envelope) {
  return envelope?.live === true &&
    envelope?.writable === true &&
    envelope?.network === 'local-devnet' &&
    envelope?.mode === CREATE_MODE &&
    envelope?.capabilities?.canCreate === true;
}

function parsePositiveInteger(value, label, errors) {
  const raw = String(value ?? '').trim();
  const number = Number(raw);
  if (!raw || !Number.isSafeInteger(number) || number <= 0) {
    errors.push(label + '은(는) 0보다 큰 정수여야 합니다.');
    return null;
  }
  return number;
}

export function buildCreateRequest(fields) {
  const errors = [];
  const name = String(fields.name ?? '').trim();
  const ticker = String(fields.ticker ?? '').trim().replace(/\s+/g, '').toUpperCase();
  const description = String(fields.description ?? '').trim();
  const imageRaw = String(fields.imageUrl ?? '').trim();
  let imageUrl = '';

  if (!name) errors.push('Token name을 입력해 주세요.');
  if (name.length > 40) errors.push('Token name은 40자 이내로 입력해 주세요.');
  if (!ticker || !/^[A-Z0-9]{1,10}$/.test(ticker)) errors.push('Ticker는 영문 대문자와 숫자 1–10자로 입력해 주세요.');
  if (description.length > 280) errors.push('Description은 280자 이내로 입력해 주세요.');
  if (imageRaw) {
    imageUrl = safeImageUrl(imageRaw) ?? '';
    if (!imageUrl) errors.push('Image URL은 HTTPS 주소여야 합니다.');
  }

  const inventory = parsePositiveInteger(fields.inventoryAtoms, 'Sale inventory', errors);
  const reserve = parsePositiveInteger(fields.reservePriceAtoms, 'Reserve price', errors);
  const deposit = parsePositiveInteger(fields.depositLotAtoms, 'Deposit lot', errors);
  const commitMinutes = parsePositiveInteger(fields.commitWindowMinutes, 'Commit window', errors);
  const openMinutes = parsePositiveInteger(fields.openWindowMinutes, 'Open window', errors);
  if (commitMinutes != null && commitMinutes < 5) errors.push('Commit window는 최소 5분(300초)이어야 합니다.');
  if (commitMinutes != null && commitMinutes > Math.floor(Number.MAX_SAFE_INTEGER / 60)) errors.push('Commit window 값이 너무 큽니다.');
  if (openMinutes != null && openMinutes > Math.floor(Number.MAX_SAFE_INTEGER / 60)) errors.push('Open window 값이 너무 큽니다.');

  return {
    errors,
    payload: {
      metadata: { name, ticker, imageUrl, description },
      config: {
        inventoryAtoms: inventory == null ? '' : String(inventory),
        reservePriceAtoms: reserve == null ? '' : String(reserve),
        depositLotAtoms: deposit == null ? '' : String(deposit),
        commitWindowSeconds: commitMinutes == null ? 0 : commitMinutes * 60,
        openWindowSeconds: openMinutes == null ? 0 : openMinutes * 60,
      },
    },
  };
}

export function isVerifiedLaunch(launch) {
  if (!launch || typeof launch !== 'object') return false;
  const address = launch.contractAddress;
  const receipts = launch.receipts;
  const config = launch.config;
  return nonEmpty(address) &&
    (!launch.id || launch.id === address) &&
    ALLOWED_PHASES.has(launch.phase) &&
    typeof launch.metadataAnchored === 'boolean' &&
    positiveInteger(config?.inventoryAtoms) &&
    positiveInteger(config?.reservePriceAtoms) &&
    positiveInteger(config?.depositLotAtoms) &&
    validReceipt(receipts?.deploy) &&
    validReceipt(receipts?.mint) &&
    validReceipt(receipts?.fund);
}

export function deriveRecordedLaunch(evidence) {
  if (!evidence || evidence.recorded !== true || evidence.readback?.settled !== true) return null;
  if (!nonEmpty(evidence.contractAddress) || !Array.isArray(evidence.receipts) || evidence.receipts.length !== evidence.receiptCount) return null;
  const findReceipt = (stage) => evidence.receipts.find((receipt) => receipt.stage === stage);
  const deploy = findReceipt('deploy');
  const mint = findReceipt('mint-sale-inventory');
  const fund = findReceipt('fund-contract-inventory');
  if (!validReceipt(deploy) || !validReceipt(mint) || !validReceipt(fund)) return null;

  return {
    id: evidence.contractAddress,
    contractAddress: evidence.contractAddress,
    metadata: { name: null, ticker: null, imageUrl: null, description: null },
    config: {
      inventoryAtoms: evidence.fixture?.inventoryAtoms ?? null,
      reservePriceAtoms: evidence.fixture?.reservePriceAtoms ?? null,
      depositLotAtoms: evidence.fixture?.depositLotAtomsPerRegisteredBid?.[0] ?? null,
      commitWindowSeconds: null,
      openWindowSeconds: null,
    },
    phase: 'settled',
    createdAt: evidence.checkedAt ?? null,
    metadataAnchored: false,
    receipts: { deploy, mint, fund },
    evidenceSource: 'local-devnet',
    sourceKind: 'recorded-evidence',
    settlement: {
      clearingPriceAtoms: evidence.readback.clearingPriceAtoms,
      allocationsAtoms: evidence.readback.allocationsAtoms,
      refundsAtoms: evidence.readback.refundsAtoms,
      tokenClaimed: evidence.readback.tokenClaimed,
      refundClaimed: evidence.readback.refundClaimed,
    },
    receiptCount: evidence.receiptCount,
    blockRange: evidence.receiptBlockRange ?? null,
    registeredBidCount: evidence.fixture?.registeredBidCount ?? null,
  };
}

export function parseRoute(hash) {
  const route = String(hash ?? '').replace(/^#\/?/, '').split('?')[0];
  if (route === 'create') return { view: 'create' };
  const tokenMatch = route.match(/^token\/([^/]+)$/);
  if (tokenMatch) return { view: 'detail', id: decodeURIComponent(tokenMatch[1]) };
  return { view: 'explore' };
}

export function phaseLabel(phase) {
  const labels = {
    upcoming: 'Upcoming',
    commit: 'Bidding live',
    open: 'Opening window',
    settling: 'Settlement pending',
    settled: 'Auction settled',
    cancelled: 'Cancelled',
    unknown: 'Final status not recorded',
  };
  return labels[phase] ?? 'Status unavailable';
}

function formatInteger(value) {
  if (value == null || !/^\d+$/.test(String(value))) return '—';
  return String(BigInt(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatWindowSeconds(value) {
  if (!Number.isSafeInteger(Number(value)) || Number(value) <= 0) return 'Not in record';
  const seconds = Number(value);
  return seconds % 60 === 0 ? (seconds / 60) + ' min' : seconds + ' sec';
}

function shortAddress(address) {
  if (!nonEmpty(address)) return 'Address unavailable';
  return address.length > 19 ? address.slice(0, 10) + '…' + address.slice(-6) : address;
}

function safeImageUrl(value) {
  if (!nonEmpty(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function sameLaunch(left, right) {
  return left.contractAddress.toLowerCase() === right.contractAddress.toLowerCase();
}

function mergeLaunches(recorded, catalog) {
  const byAddress = new Map();
  for (const launch of recorded) byAddress.set(launch.contractAddress.toLowerCase(), launch);
  for (const launch of catalog) {
    const key = launch.contractAddress.toLowerCase();
    const existing = byAddress.get(key);
    byAddress.set(key, existing
      ? { ...existing, ...launch, settlement: launch.settlement ?? existing.settlement, receiptCount: existing.receiptCount ?? launch.receiptCount, blockRange: existing.blockRange ?? launch.blockRange, sourceKind: existing.sourceKind === 'recorded-evidence' ? 'recorded-evidence' : launch.sourceKind ?? existing.sourceKind }
      : launch);
  }
  return [...byAddress.values()].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
}

function launchLabel(launch) {
  return nonEmpty(launch.metadata?.name) ? launch.metadata.name : 'Unlabeled test token';
}

function launchTicker(launch) {
  return nonEmpty(launch.metadata?.ticker) ? launch.metadata.ticker : '';
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = String(text);
  return element;
}

function appendMetric(parent, label, value) {
  const cell = makeElement('div');
  cell.append(makeElement('span', '', label), makeElement('strong', '', value));
  parent.append(cell);
}

function verifiedCatalogEntry(entry) {
  if (!isVerifiedLaunch(entry)) return null;
  if (entry.phase === 'settled' || entry.phase === 'cancelled') return { ...entry, sourceKind: 'catalog' };
  const commit = Number(entry.commitDeadlineUnixSeconds);
  const open = Number(entry.openDeadlineUnixSeconds);
  if (!Number.isSafeInteger(commit) || !Number.isSafeInteger(open) || commit >= open) {
    return { ...entry, sourceKind: 'catalog' };
  }
  const now = Math.floor(Date.now() / 1000);
  const phase = now < commit ? 'commit' : now < open ? 'open' : 'unknown';
  return { ...entry, phase, sourceKind: 'catalog' };
}

function initializePage() {
  const $ = (selector) => document.querySelector(selector);
  createLocaleController();
  initFairLaunchWallet();
  const viewNodes = {
    explore: $('#exploreView'),
    create: $('#createView'),
    detail: $('#detailView'),
  };
  const searchInput = $('#launchSearch');
  const listingGrid = $('#launchGrid');
  const catalogStatus = $('#catalogStatus');
  const emptyState = $('#emptyState');
  const creatorForm = $('#creatorForm');
  const createLaunchButton = $('#createLaunchButton');
  const createAvailability = $('#createAvailability');
  const createError = $('#createError');
  const previewImage = $('#previewImage');
  const previewMonogram = $('#previewMonogram');

  let launches = [];
  let capabilityEnvelope = null;
  let activeFilter = 'all';
  let currentRoute = parseRoute(window.location.hash);
  let creating = false;
  let recoveryRequired = false;

  function setCatalogMessage(message, kind = '') {
    catalogStatus.textContent = message;
    catalogStatus.className = 'catalog-status' + (kind ? ' is-' + kind : '');
  }

  function setEmptyState(title, message, showClear = false) {
    $('#emptyTitle').textContent = title;
    $('#emptyMessage').textContent = message;
    $('#clearFiltersButton').hidden = !showClear;
    emptyState.hidden = false;
  }

  function renderCard(launch) {
    const article = makeElement('article', 'launch-card');
    article.setAttribute('role', 'listitem');
    const link = makeElement('a', 'launch-card-link');
    link.href = '#/token/' + encodeURIComponent(launch.id || launch.contractAddress);
    link.setAttribute('aria-label', launchLabel(launch) + ', ' + phaseLabel(launch.phase) + ', ' + shortAddress(launch.contractAddress));

    const art = makeElement('div', 'launch-card-art');
    art.setAttribute('aria-hidden', 'true');
    const genericMark = makeElement('span', 'token-placeholder-mark', '✳');
    art.append(genericMark);
    const imageUrl = safeImageUrl(launch.metadata?.imageUrl);
    if (imageUrl) {
      const image = makeElement('img');
      image.src = imageUrl;
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.onerror = () => image.remove();
      art.append(image);
    }
    art.append(makeElement('span', 'art-network', 'MIDNIGHT · TEST'));

    const body = makeElement('div', 'launch-card-body');
    const top = makeElement('div', 'launch-card-top');
    const phase = makeElement('span', 'phase-chip is-' + launch.phase, phaseLabel(launch.phase));
    const network = makeElement('span', 'launch-network', launch.sourceKind === 'recorded-evidence' ? 'RECORDED LOCAL DEVNET' : 'LOCAL DEVNET');
    top.append(phase, network);

    const nameRow = makeElement('div', 'launch-name-row');
    nameRow.append(makeElement('h2', '', launchLabel(launch)));
    if (!launch.metadataAnchored) nameRow.append(makeElement('span', 'metadata-tag', 'Metadata not anchored'));
    else if (!launchTicker(launch)) nameRow.append(makeElement('span', 'metadata-tag', 'No ticker'));

    const ticker = launchTicker(launch);
    const contract = makeElement('p', 'contract-short', shortAddress(launch.contractAddress));
    contract.title = launch.contractAddress;
    if (ticker) {
      const tickerLine = makeElement('p', 'launch-ticker', '$' + ticker);
      body.append(top, nameRow, tickerLine, contract);
    } else {
      body.append(top, nameRow, contract);
    }

    const metrics = makeElement('div', 'launch-card-metrics');
    appendMetric(metrics, 'Sale inventory', formatInteger(launch.config?.inventoryAtoms) + ' units');
    appendMetric(metrics, 'Reserve', formatInteger(launch.config?.reservePriceAtoms) + ' TEST');
    if (launch.settlement?.clearingPriceAtoms != null) {
      appendMetric(metrics, 'Clearing price', formatInteger(launch.settlement.clearingPriceAtoms) + ' TEST');
    } else {
      appendMetric(metrics, 'Deposit lot', formatInteger(launch.config?.depositLotAtoms) + ' TEST');
    }
    const footer = makeElement('div', 'launch-card-footer');
    const receiptText = launch.receiptCount
      ? launch.receiptCount + ' recorded transactions'
      : '3 setup receipts verified';
    footer.append(makeElement('span', 'recorded-count', receiptText), makeElement('span', 'open-label', 'View auction →'));

    body.append(metrics, footer);
    link.append(art, body);
    article.append(link);
    return article;
  }

  function matchesFilter(launch) {
    if (activeFilter === 'all') return true;
    if (activeFilter === 'live') return launch.phase === 'commit';
    return launch.phase === activeFilter;
  }

  function renderCatalog() {
    listingGrid.replaceChildren();
    const query = searchInput.value.trim().toLocaleLowerCase();
    const visible = launches.filter((launch) => {
      if (!matchesFilter(launch)) return false;
      const searchText = [launchLabel(launch), launchTicker(launch), launch.contractAddress, phaseLabel(launch.phase), 'local devnet'].join(' ').toLocaleLowerCase();
      return !query || searchText.includes(query);
    });

    if (visible.length === 0) {
      const noResults = Boolean(query);
      if (launches.length > 0) {
        const emptyStatus = noResults
          ? 'No verified launches match this search.'
          : activeFilter === 'live'
            ? 'No verified live auctions are available.'
            : activeFilter === 'upcoming'
              ? 'No verified upcoming auctions are available.'
              : 'No verified settled auctions match this filter.';
        setCatalogMessage(emptyStatus, 'warning');
      }
      const phaseTitle = activeFilter === 'live' ? 'No live auctions yet'
        : activeFilter === 'upcoming' ? 'No upcoming auctions yet'
          : activeFilter === 'settled' ? 'No settled auctions found' : '표시할 출시가 없습니다';
      const phaseMessage = noResults
        ? '검색어나 계약 주소와 일치하는 검증된 출시가 없습니다.'
        : activeFilter === 'live'
          ? '현재 입찰이 진행 중인 것으로 검증된 Local Devnet 경매가 없습니다.'
          : activeFilter === 'upcoming'
            ? '현재 입찰 예정 상태로 검증된 Local Devnet 경매가 없습니다.'
            : '선택한 조건에 맞는 영수증 검증 경매가 없습니다.';
      setEmptyState(noResults ? '검색 결과가 없습니다' : phaseTitle, phaseMessage, activeFilter !== 'all' || noResults);
      return;
    }

    emptyState.hidden = true;
    for (const launch of visible) listingGrid.append(renderCard(launch));
    const kind = capabilityEnvelope ? 'live verified catalog' : 'recorded evidence';
    setCatalogMessage(visible.length + (visible.length === 1 ? ' verified launch' : ' verified launches') + ' · ' + kind + ' · read-only unless Create API is enabled');
  }

  async function readJson(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }

  function setCreateAvailability(envelope) {
    capabilityEnvelope = envelope;
    const localOperatorMode = envelope?.live === true &&
      envelope?.network === 'local-devnet' &&
      envelope?.mode === CREATE_MODE;
    const enabled = canCreateFromEnvelope(envelope) && localOperatorMode;
    createLaunchButton.disabled = !enabled || creating;
    if (enabled) {
      createAvailability.textContent = 'Operator-sponsored Local Devnet test mode is ready. The operator signs mint and funding actions; this is not a user-wallet or permissionless launch.';
      $('#networkPill').classList.add('is-operator');
      $('#networkPill').classList.remove('is-live');
      $('#networkLabel').textContent = 'Operator demo · Local Devnet';
    } else if (localOperatorMode) {
      createAvailability.textContent = 'Operator-sponsored Local Devnet mode is connected, but Create is currently disabled by the backend.';
      $('#networkPill').classList.add('is-operator');
      $('#networkPill').classList.remove('is-live');
      $('#networkLabel').textContent = 'Operator demo · Local Devnet';
    } else if (envelope?.live === true && envelope?.network === 'local-devnet') {
      createAvailability.textContent = 'The verified Local Devnet catalog is available. This backend mode does not expose operator Create.';
      $('#networkPill').classList.remove('is-operator');
      $('#networkPill').classList.add('is-live');
      $('#networkLabel').textContent = 'Verified catalog · Local Devnet';
    } else {
      createAvailability.textContent = envelope?.mode && envelope.mode !== CREATE_MODE
        ? '현재 백엔드 모드는 Create를 지원하지 않습니다. 초안 미리보기만 사용할 수 있습니다.'
        : 'Draft preview only. Create activates only when the Local Devnet operator API explicitly reports canCreate=true.';
      $('#networkPill').classList.remove('is-operator');
      $('#networkPill').classList.remove('is-live');
      $('#networkLabel').textContent = 'Recorded data · Read only';
    }
    createLaunchButton.setAttribute('aria-describedby', 'createAvailability');
  }

  async function loadLaunches() {
    setCatalogMessage('Loading receipt-verified launches…');
    const [evidenceResult, catalogResult, staticCatalogResult] = await Promise.allSettled([
      readJson(RECORDED_EVIDENCE_URL),
      readJson(LAUNCHES_URL),
      readJson(RECORDED_CATALOG_URL),
    ]);

    const recorded = evidenceResult.status === 'fulfilled' ? deriveRecordedLaunch(evidenceResult.value) : null;
    const envelope = catalogResult.status === 'fulfilled' ? catalogResult.value : null;
    const apiReady = Boolean(
      envelope && typeof envelope === 'object' &&
      envelope.live === true &&
      envelope.network === 'local-devnet' &&
      Array.isArray(envelope.launches),
    );
    const staticCatalog = staticCatalogResult.status === 'fulfilled' && staticCatalogResult.value?.version === 1 && Array.isArray(staticCatalogResult.value.launches)
      ? staticCatalogResult.value.launches.map(verifiedCatalogEntry).filter(Boolean)
      : [];
    const catalog = apiReady
      ? envelope.launches.map(verifiedCatalogEntry).filter(Boolean)
      : staticCatalog;
    launches = mergeLaunches(recorded ? [recorded] : [], catalog);
    setCreateAvailability(apiReady ? envelope : null);

    if (!apiReady && catalog.length > 0) {
      setCatalogMessage('Showing ' + launches.length + ' recorded Local Devnet launches. Create requires the local operator API.', 'warning');
    } else if (!apiReady && recorded) {
      setCatalogMessage('Showing one recorded Local Devnet launch. No write API is connected.', 'warning');
    } else if (!apiReady && !recorded) {
      setCatalogMessage('Launch data could not be loaded. No unverified cards are shown.', 'error');
    } else if (apiReady && catalog.length !== envelope.launches.length) {
      setCatalogMessage('Some catalog entries were omitted because deploy, mint, or funding receipts were incomplete.', 'warning');
    }
    renderCatalog();
    if (currentRoute.view === 'detail') renderDetail(currentRoute.id);
    if (apiReady && catalog.length === 0 && !recorded) {
      setEmptyState('No verified launches yet', '배포, 토큰 발행, 재고 예치 영수증이 확인된 출시가 아직 없습니다.', false);
    }
  }

  function setActiveView(route) {
    currentRoute = route;
    viewNodes.explore.hidden = route.view !== 'explore';
    viewNodes.create.hidden = route.view !== 'create';
    viewNodes.detail.hidden = route.view !== 'detail';
    $('#navExplore').classList.toggle('active', route.view !== 'create');
    $('#navCreate').classList.toggle('active', route.view === 'create');
    if (route.view === 'create') {
      $('#navCreate').setAttribute('aria-current', 'page');
      $('#navExplore').removeAttribute('aria-current');
    } else {
      $('#navExplore').setAttribute('aria-current', 'page');
      $('#navCreate').removeAttribute('aria-current');
    }
    if (route.view === 'detail') renderDetail(route.id);
    const heading = route.view === 'explore' ? $('#exploreTitle') : route.view === 'create' ? $('#createTitle') : $('#detailTitle');
    if (heading && !viewNodes[route.view].hidden) requestAnimationFrame(() => heading.focus({ preventScroll: true }));
  }

  function renderDetail(id) {
    const launch = launches.find((item) => item.id === id || item.contractAddress.toLowerCase() === String(id).toLowerCase());
    $('#detailContent').hidden = !launch;
    $('#detailMissing').hidden = Boolean(launch);
    if (!launch) return;

    const metadataName = nonEmpty(launch.metadata?.name) ? launch.metadata.name : 'Unlabeled test token';
    $('#detailTitle').textContent = metadataName;
    $('#detailEyebrow').textContent = launch.sourceKind === 'recorded-evidence'
      ? 'RECORDED MIDNIGHT LOCAL DEVNET LAUNCH'
      : 'VERIFIED MIDNIGHT LOCAL DEVNET LAUNCH';
    $('#detailContract').textContent = shortAddress(launch.contractAddress);
    $('#detailContract').title = launch.contractAddress;
    $('#metadataNote').textContent = launch.metadataAnchored
      ? '메타데이터 해시가 계약에 고정되었습니다.'
      : '계약에 이름, 티커, 이미지 메타데이터가 연결되지 않은 테스트 토큰입니다.';
    const status = $('#detailStatus');
    status.className = 'status-chip is-' + launch.phase;
    status.textContent = phaseLabel(launch.phase);

    const config = launch.config ?? {};
    const hasSettlement = launch.phase === 'settled' && launch.settlement?.clearingPriceAtoms != null;
    $('#detailOutcomeEyebrow').textContent = hasSettlement ? 'AUCTION OUTCOME' : 'AUCTION CONFIGURATION';
    $('#outcomeTitle').textContent = hasSettlement ? 'Settlement record' : 'Auction rules';
    $('#detailRecordTag').textContent = launch.sourceKind === 'recorded-evidence' ? 'RECORDED' : 'VERIFIED';
    $('#detailClearingPrice').textContent = hasSettlement
      ? formatInteger(launch.settlement.clearingPriceAtoms) + ' TEST'
      : launch.phase === 'cancelled' ? 'Cancelled' : 'Not settled';
    $('#detailInventory').textContent = formatInteger(config.inventoryAtoms) + ' units';
    $('#detailReserve').textContent = formatInteger(config.reservePriceAtoms) + ' TEST';
    $('#detailDeposit').textContent = formatInteger(config.depositLotAtoms) + ' TEST';
    const slotCount = launch.registeredBidCount ?? (launch.settlement?.allocationsAtoms?.length ?? null);
    $('#detailSlots').textContent = slotCount == null ? 'Not in catalog' : formatInteger(slotCount);
    $('#detailCommitWindow').textContent = formatWindowSeconds(config.commitWindowSeconds);
    $('#detailOpenWindow').textContent = formatWindowSeconds(config.openWindowSeconds);
    const receiptCount = launch.receiptCount ?? 3;
    $('#detailReceipts').textContent = formatInteger(receiptCount) + ' transactions';
    $('#detailReceiptCount').textContent = formatInteger(receiptCount) + ' tx';

    const allocations = launch.settlement?.allocationsAtoms;
    const refunds = launch.settlement?.refundsAtoms;
    const allocationList = $('#allocationList');
    allocationList.replaceChildren();
    if (launch.phase === 'settled' && Array.isArray(allocations) && Array.isArray(refunds)) {
      for (let index = 0; index < Math.min(allocations.length, refunds.length); index += 1) {
        const row = makeElement('div', 'slot-row');
        row.append(makeElement('span', 'slot-index', 'Slot ' + (index + 1)));
        const allocation = makeElement('span', 'slot-outcome', 'Allocated');
        allocation.append(makeElement('strong', '', formatInteger(allocations[index]) + ' units'));
        const refund = makeElement('span', 'slot-outcome', 'Refund');
        refund.append(makeElement('strong', '', formatInteger(refunds[index]) + ' TEST'));
        row.append(allocation, refund);
        allocationList.append(row);
      }
      allocationList.hidden = false;
    } else {
      allocationList.hidden = true;
    }
    $('#detailPanelNote').textContent = allocations && refunds
      ? 'Slot outcomes are public settlement data for this completed auction.'
      : 'Settlement has not been recorded for this launch; no clearing price or slot outcome is shown.';

    const isSettled = launch.phase === 'settled' || launch.phase === 'cancelled';
    $('#detailBidButton').textContent = launch.phase === 'settled'
      ? 'Bid · auction settled'
      : launch.phase === 'cancelled'
        ? 'Bid · auction cancelled'
        : launch.phase === 'open'
          ? 'Bid closed · opening window'
          : launch.phase === 'upcoming'
            ? 'Bid · not open yet'
            : 'Bid · wallet unavailable';
    $('#actionExplanation').textContent = isSettled
      ? '이 경매는 종료되었습니다. 이 페이지는 개인 지갑 상태를 조회하지 않는 기록용 화면입니다.'
      : '경매 상태는 검증된 카탈로그에서 읽었습니다. 지갑 연결과 봉인 입찰 제출은 아직 지원하지 않습니다.';
    $('#detailTokenClaimButton').disabled = true;
    $('#detailRefundClaimButton').disabled = true;

    if (launch.sourceKind === 'recorded-evidence') {
      $('#detailEvidenceLink').href = RECORDED_EVIDENCE_URL;
      $('#detailEvidenceLink').hidden = false;
      $('#detailEvidenceNote').textContent = '20개의 기록된 Local Devnet 거래와 최종 지갑 readback을 볼 수 있습니다. 이 파일은 저장된 증거이며 실시간 조회가 아닙니다.';
    } else if (nonEmpty(launch.evidenceUrl)) {
      $('#detailEvidenceLink').href = launch.evidenceUrl;
      $('#detailEvidenceLink').hidden = false;
      $('#detailEvidenceNote').textContent = '이 출시의 기록된 증거 문서입니다.';
    } else {
      $('#detailEvidenceLink').hidden = true;
      $('#detailEvidenceNote').textContent = '배포·발행·예치 확인 영수증은 카탈로그 응답에 포함되어 있습니다.';
    }
  }

  function updateDraftPreview() {
    const name = $('#tokenName').value.trim();
    const ticker = $('#tokenTicker').value.trim().replace(/\s+/g, '').toUpperCase();
    const description = $('#tokenDescription').value.trim();
    const imageValue = $('#tokenImage').value.trim();
    const safeImage = safeImageUrl(imageValue);

    $('#previewName').textContent = name || 'Your token name';
    $('#previewTicker').textContent = ticker ? '$' + ticker : 'TICKER';
    $('#previewDescription').textContent = description || '토큰 설명을 입력하면 여기에 표시됩니다.';
    $('#previewInventory').textContent = $('#inventoryAtoms').value ? formatInteger($('#inventoryAtoms').value) + ' units' : 'Not set';
    $('#previewReserve').textContent = $('#reservePriceAtoms').value ? formatInteger($('#reservePriceAtoms').value) + ' TEST' : 'Not set';
    $('#previewDeposit').textContent = $('#depositLotAtoms').value ? formatInteger($('#depositLotAtoms').value) + ' TEST' : 'Not set';
    $('#previewCommitWindow').textContent = $('#commitWindowMinutes').value ? formatInteger($('#commitWindowMinutes').value) + ' min' : 'Not set';
    if (safeImage) {
      previewMonogram.hidden = true;
      previewImage.hidden = false;
      previewImage.src = safeImage;
      previewImage.onerror = () => {
        previewImage.hidden = true;
        previewMonogram.hidden = false;
      };
    } else {
      previewImage.removeAttribute('src');
      previewImage.hidden = true;
      previewMonogram.hidden = false;
    }
  }

  function readCreatePayload() {
    return {
      ...buildCreateRequest({
        name: $('#tokenName').value,
        ticker: $('#tokenTicker').value,
        imageUrl: $('#tokenImage').value,
        description: $('#tokenDescription').value,
        inventoryAtoms: $('#inventoryAtoms').value,
        reservePriceAtoms: $('#reservePriceAtoms').value,
        depositLotAtoms: $('#depositLotAtoms').value,
        commitWindowMinutes: $('#commitWindowMinutes').value,
        openWindowMinutes: $('#openWindowMinutes').value,
      }),
    };
  }

  function upsertLaunch(launch) {
    const index = launches.findIndex((item) => sameLaunch(item, launch));
    if (index === -1) launches = [launch, ...launches];
    else launches[index] = { ...launches[index], ...launch, settlement: launch.settlement ?? launches[index].settlement };
    renderCatalog();
  }

  async function submitCreate(event) {
    event.preventDefault();
    createError.hidden = true;
    if (createLaunchButton.disabled || !capabilityEnvelope) {
      createError.textContent = 'Operator Create API가 실행 가능한 상태가 아닙니다. 초안 미리보기만 사용할 수 있습니다.';
      createError.hidden = false;
      return;
    }
    const { errors, payload } = readCreatePayload();
    if (errors.length) {
      createError.textContent = errors.join(' ');
      createError.hidden = false;
      return;
    }

    creating = true;
    createLaunchButton.disabled = true;
    createLaunchButton.textContent = 'Creating test launch…';
    createAvailability.textContent = 'Operator-sponsored Local Devnet Create 요청을 처리 중입니다.';
    try {
      const response = await fetch(CREATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || data.message || 'Create API returned HTTP ' + response.status + '.');
      if (data.status === 'recovery-required') {
        recoveryRequired = true;
        createError.textContent = data.message || '체인 작업이 완료되지 않았습니다. 복구 상태를 확인하기 전까지 목록에 추가하지 않습니다.';
        createError.hidden = false;
        createAvailability.textContent = '복구 확인 전까지 새 Create 요청을 보낼 수 없습니다. 운영자 확인이 필요합니다.';
        return;
      }
      if (data.status !== 'confirmed' || !isVerifiedLaunch(data.launch)) {
        throw new Error('Create 결과에 배포·발행·재고 예치 영수증이 모두 확인되지 않았습니다. Explore 목록에는 추가하지 않았습니다.');
      }
      const confirmed = { ...data.launch, sourceKind: 'catalog' };
      upsertLaunch(confirmed);
      createAvailability.textContent = '배포, 발행, 재고 예치 영수증이 확인되었습니다. 검증된 출시를 열었습니다.';
      window.location.hash = '#/token/' + encodeURIComponent(confirmed.id || confirmed.contractAddress);
    } catch (error) {
      createError.textContent = error.message || 'Create 요청을 완료하지 못했습니다.';
      createError.hidden = false;
      createAvailability.textContent = '초안은 이 탭에서만 유지됩니다. 서버 응답을 확인한 뒤 다시 시도할 수 있습니다.';
    } finally {
      creating = false;
      createLaunchButton.textContent = 'Create test launch';
      const canCreate = canCreateFromEnvelope(capabilityEnvelope);
      createLaunchButton.disabled = !canCreate || recoveryRequired;
    }
  }

  function bindEvents() {
    searchInput.addEventListener('input', renderCatalog);
    document.querySelectorAll('[data-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        activeFilter = button.dataset.filter;
        document.querySelectorAll('[data-filter]').forEach((item) => {
          const selected = item === button;
          item.classList.toggle('is-selected', selected);
          item.setAttribute('aria-pressed', String(selected));
        });
        renderCatalog();
      });
    });
    $('#clearFiltersButton').addEventListener('click', () => {
      searchInput.value = '';
      activeFilter = 'all';
      document.querySelectorAll('[data-filter]').forEach((item) => {
        const selected = item.dataset.filter === 'all';
        item.classList.toggle('is-selected', selected);
        item.setAttribute('aria-pressed', String(selected));
      });
      renderCatalog();
      searchInput.focus();
    });
    document.querySelectorAll('#creatorForm input, #creatorForm textarea').forEach((input) => {
      input.addEventListener('input', updateDraftPreview);
    });
    creatorForm.addEventListener('submit', submitCreate);
    $('#copyContractButton').addEventListener('click', async () => {
      const launch = launches.find((item) => item.id === currentRoute.id || item.contractAddress.toLowerCase() === String(currentRoute.id).toLowerCase());
      if (!launch || !navigator.clipboard?.writeText) return;
      try {
        await navigator.clipboard.writeText(launch.contractAddress);
        $('#copyContractButton').textContent = 'Copied';
        window.setTimeout(() => { $('#copyContractButton').textContent = 'Copy'; }, 1200);
      } catch {
        $('#copyContractButton').textContent = 'Copy unavailable';
      }
    });
    window.addEventListener('hashchange', () => {
      const nextRoute = parseRoute(window.location.hash);
      const changed = JSON.stringify(nextRoute) !== JSON.stringify(currentRoute);
      currentRoute = nextRoute;
      setActiveView(nextRoute);
      if (changed) window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey &&
        !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
        event.preventDefault();
        if (!viewNodes.explore.hidden) searchInput.focus();
      }
    });
  }

  bindEvents();
  setActiveView(currentRoute);
  updateDraftPreview();
  void loadLaunches();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializePage, { once: true });
  } else {
    initializePage();
  }
}
