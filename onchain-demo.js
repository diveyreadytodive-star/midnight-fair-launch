const sources = {
  local: './fair-launch-evidence.json',
  preprodSetup: './preprod-launch-evidence.json',
  preprodFull: './preprod-auction-evidence.json',
  preprodFullSetup: './preprod-auction-setup.json',
};
const copy = {
  en: {
    skip: 'Skip to content', explore: 'Explore', judge: 'Judge demo', proof: 'On-chain proof', badge: 'RECORDED EXECUTION',
    eyebrow: 'MIDNIGHT · TRANSACTION EVIDENCE', title: 'The auction ran on chain',
    intro: 'Follow the contract calls behind sealed bids, uniform-price settlement, and claims.',
    disclosureTitle: 'Recorded execution · no new transaction',
    disclosure: 'This page reads saved receipts. The operator signed the test transactions. Your browser does not connect a wallet or submit a bid.',
    resultEyebrow: 'COMPLETED TEST AUCTION', resultTitle: 'Verified result', network: 'Network', transactions: 'Transactions',
    price: 'Clearing price', allocations: 'Allocations', stepsEyebrow: 'FROM CONTRACT TO CLAIM', stepsTitle: 'Four steps, real receipts',
    setupEyebrow: 'PUBLIC TESTNET', setupTitle: 'Preprod setup',
    setupPartial: 'A separate Preprod contract was deployed, its valueless token minted, and inventory funded. These three transactions do not establish a completed Preprod auction.',
    setupComplete: 'This Preprod contract was deployed, its valueless token minted, and inventory funded before the completed operator auction below.',
    setupLink: 'Open Preprod setup evidence ↗', loading: 'Loading saved evidence…', unavailable: 'Complete auction evidence is unavailable. No outcome is asserted.',
    boundaryLocal: 'The completed run used an operator-controlled Local Devnet. These are saved receipts, not a live public-chain query.',
    boundaryPreprod: 'This completed Preprod run was signed by one operator wallet using valueless test assets. It is not independent user participation.',
    footerLocal: 'The recorded four-slot run proves the contract flow, not independent public-wallet participation, resistance to slot sniping, production liquidity, or a raw-transaction privacy audit.',
    footerPreprod: 'The operator possessed all four bid openings and signed every action. Public-wallet participation, fair slot admission, production liquidity, and raw-transaction privacy remain unproven.',
    setup: 'Deploy, mint, and fund', bid: 'Seal four funded bids', settle: 'Verify one clearing price', claim: 'Return funds and claim tokens',
    localNetwork: 'Local Devnet', preprodNetwork: 'Preprod', tx: 'tx', block: 'Block', evidence: 'Open full auction evidence ↗',
  },
  ko: {
    skip: '본문으로 건너뛰기', explore: '탐색', judge: '심사위원 체험', proof: '온체인 증거', badge: '기록된 실제 실행',
    eyebrow: 'MIDNIGHT · 거래 증거', title: '경매가 실제 체인에서 실행됐습니다',
    intro: '봉인 입찰, 단일 청산가격 정산, 수령까지의 계약 호출을 확인하세요.',
    disclosureTitle: '기록된 실행 · 새 거래 없음',
    disclosure: '이 화면은 저장된 영수증을 읽습니다. 테스트 거래는 운영자 지갑이 서명했으며, 이 브라우저는 지갑을 연결하거나 입찰을 제출하지 않습니다.',
    resultEyebrow: '완료된 테스트 경매', resultTitle: '검증된 결과', network: '네트워크', transactions: '거래 수',
    price: '청산가격', allocations: '배정량', stepsEyebrow: '배포부터 수령까지', stepsTitle: '네 단계의 실제 영수증',
    setupEyebrow: '공개 테스트넷', setupTitle: 'Preprod 설치 거래',
    setupPartial: '별도 Preprod 계약을 배포하고 가치 없는 토큰을 발행해 재고를 예치했습니다. 이 세 거래만으로 Preprod 경매 완주를 주장하지 않습니다.',
    setupComplete: '아래 운영자 경매 실행 전에 같은 Preprod 계약을 배포하고 가치 없는 토큰을 발행·예치했습니다.',
    setupLink: 'Preprod 설치 증거 보기 ↗', loading: '저장된 증거를 불러오는 중…', unavailable: '완료된 경매 증거를 불러올 수 없어 결과를 표시하지 않습니다.',
    boundaryLocal: '완료된 실행은 운영자가 제어한 Local Devnet에서 이루어졌습니다. 저장된 영수증이며 공개 체인의 실시간 조회가 아닙니다.',
    boundaryPreprod: '완료된 Preprod 실행은 운영자 지갑 하나가 가치 없는 테스트 자산으로 서명했습니다. 개별 사용자 참여 실증은 아닙니다.',
    footerLocal: '기록된 4인 경매는 계약 흐름을 증명하지만 개별 지갑 참여, 슬롯 선점 방지, 실거래 유동성, 원시 거래 프라이버시 검증까지 증명하지는 않습니다.',
    footerPreprod: '운영자가 네 입찰 opening을 모두 보유하고 모든 동작에 서명했습니다. 개별 지갑 참여, 공정한 슬롯 진입, 실거래 유동성, 원시 거래 프라이버시는 미검증입니다.',
    setup: '배포·발행·예치', bid: '예치 입찰 4건 봉인', settle: '단일 청산가격 검증', claim: '환불·대금·토큰 수령',
    localNetwork: 'Local Devnet', preprodNetwork: 'Preprod', tx: '거래', block: '블록', evidence: '전체 경매 증거 보기 ↗',
  },
};

const $ = (id) => document.getElementById(id);
const validReceipt = (receipt) => /^[0-9a-f]{66}$/i.test(receipt?.txId ?? '') &&
  /^[0-9a-f]{64}$/i.test(receipt?.transactionHash ?? '') && Number.isSafeInteger(receipt?.blockHeight);
const receiptEntries = (receipts) => Array.isArray(receipts)
  ? receipts.map(({ stage, ...receipt }) => ({ stage, ...receipt }))
  : Object.entries(receipts ?? {}).map(([stage, receipt]) => ({ stage, ...receipt }));
const bidStages = Array.from({ length: 4 }, (_, slot) => [`mint-payment-${slot}`, `register-bid-${slot}`]).flat();
const claimStages = [...Array.from({ length: 4 }, (_, slot) => `claim-refund-${slot}`),
  'claim-proceeds-0', 'claim-proceeds-1', 'claim-tokens-0', 'claim-tokens-1'];
const preprodStages = [...bidStages, 'settle-four-bids', ...claimStages];
const localStages = ['deploy', 'mint-sale-inventory', 'fund-contract-inventory',
  ...Array.from({ length: 4 }, (_, slot) => `mint-payment-lot-${slot}`),
  ...Array.from({ length: 4 }, (_, slot) => `register-bid-${slot}`),
  'settle-four-registered-bids', ...Array.from({ length: 4 }, (_, slot) => `claim-refund-${slot}`),
  'claim-sale-proceeds-0', 'claim-sale-proceeds-1', 'claim-sale-tokens-0', 'claim-sale-tokens-1'];
const exactStages = (receipts, stages) => receipts.length === stages.length &&
  receipts.every(validReceipt) && receipts.map((receipt) => receipt.stage).sort().join('|') === [...stages].sort().join('|') &&
  new Set(receipts.map((receipt) => receipt.txId)).size === receipts.length;

export function validLocalEvidence(value) {
  return value?.recorded === true && value?.readback?.settled === true && value?.receiptCount === 20 &&
    Array.isArray(value.receipts) && exactStages(value.receipts, localStages);
}

export function validFullPreprodEvidence(value, setup) {
  const calls = receiptEntries(value?.receipts);
  const setupCalls = receiptEntries(setup?.receipts);
  return value?.network === 'preprod' && setup?.network === 'preprod' && value?.testAssetsOnly === true &&
    setup?.testAssetsOnly === true && value?.operatorSignedAllActions === true && setup?.readback?.saleInventoryFunded === true &&
    value?.readback?.settled === true && value?.fixture?.registeredBidCount === 4 &&
    value.contractAddress === setup.contractAddress && value.sourceHash === setup.sourceHash &&
    exactStages(calls, preprodStages) &&
    exactStages(setupCalls, ['deploy', 'mint', 'fund']);
}

async function loadJson(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Evidence unavailable: ${path}`);
  return response.json();
}

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value != null) node.textContent = String(value);
  return node;
}

function receiptNode(receipt, dictionary) {
  const row = element('div', 'proof-receipt');
  row.append(element('span', '', receipt.stage), element('small', '', `${dictionary.block} ${receipt.blockHeight}`));
  const id = element('code', '', receipt.txId);
  id.title = receipt.transactionHash;
  row.append(id);
  return row;
}

function renderGroup(number, name, receipts, dictionary) {
  const details = element('details', 'proof-step');
  if (number === 2) details.open = true;
  const summary = element('summary');
  summary.append(element('span', 'proof-step-number', String(number).padStart(2, '0')),
    element('span', 'proof-step-name', name), element('span', 'proof-step-count', `${receipts.length} ${dictionary.tx}`));
  const list = element('div', 'proof-receipts');
  receipts.forEach((receipt) => list.append(receiptNode(receipt, dictionary)));
  details.append(summary, list);
  return details;
}

function splitSteps(receipts, setupReceipts) {
  return [
    setupReceipts,
    receipts.filter((receipt) => /^(?:mint-payment-|register-bid-)/.test(receipt.stage)),
    receipts.filter((receipt) => /^settle/.test(receipt.stage)),
    receipts.filter((receipt) => /^claim-/.test(receipt.stage)),
  ];
}

let language = (() => {
  if (typeof document === 'undefined') return 'en';
  try { return globalThis.localStorage?.getItem('fair-launch-locale') || (globalThis.navigator?.language?.startsWith('ko') ? 'ko' : 'en'); }
  catch { return globalThis.navigator?.language?.startsWith('ko') ? 'ko' : 'en'; }
})();
if (!copy[language]) language = 'en';
let localEvidence = null;
let preprodSetup = null;
let fullEvidence = null;
let fullSetup = null;

function render() {
  const t = copy[language];
  document.documentElement.lang = language;
  document.title = language === 'ko' ? 'Fair Launch · 온체인 증거' : 'Fair Launch · On-chain proof';
  const labels = { skipLink: 'skip', exploreLink: 'explore', judgeLink: 'judge', proofNav: 'proof', networkBadge: 'badge',
    eyebrow: 'eyebrow', title: 'title', intro: 'intro', disclosureTitle: 'disclosureTitle', disclosure: 'disclosure',
    resultEyebrow: 'resultEyebrow', resultTitle: 'resultTitle', networkLabel: 'network', transactionsLabel: 'transactions',
    priceLabel: 'price', allocationLabel: 'allocations', stepsEyebrow: 'stepsEyebrow', stepsTitle: 'stepsTitle',
    setupEyebrow: 'setupEyebrow', setupTitle: 'setupTitle' };
  for (const [id, key] of Object.entries(labels)) $(id).textContent = t[key];
  $('localeToggle').textContent = language === 'ko' ? 'English' : '한국어';

  const full = validFullPreprodEvidence(fullEvidence, fullSetup);
  const local = validLocalEvidence(localEvidence);
  const evidence = full ? fullEvidence : local ? localEvidence : null;
  const setup = full ? fullSetup : preprodSetup;
  const mainReceipts = receiptEntries(evidence?.receipts);
  const setupReceipts = full ? receiptEntries(fullSetup.receipts) : mainReceipts.slice(0, 3);
  $('resultNetwork').textContent = evidence ? full ? t.preprodNetwork : t.localNetwork : '—';
  $('resultCount').textContent = evidence ? String(mainReceipts.length + (full ? 3 : 0)) : '—';
  $('resultPrice').textContent = evidence ? `${full ? evidence.fixture.clearingPriceAtoms : evidence.readback.clearingPriceAtoms} TEST` : '—';
  $('resultAllocations').textContent = evidence ? (full ? evidence.fixture.allocationsAtoms : evidence.readback.allocationsAtoms).join(' / ') : '—';
  $('resultBoundary').textContent = evidence ? full ? t.boundaryPreprod : t.boundaryLocal : t.unavailable;
  $('footerNote').textContent = full ? t.footerPreprod : t.footerLocal;

  const steps = $('steps');
  steps.replaceChildren();
  if (!evidence) steps.append(element('p', '', t.unavailable));
  else {
    const grouped = splitSteps(mainReceipts, setupReceipts);
    [t.setup, t.bid, t.settle, t.claim].forEach((name, index) => steps.append(renderGroup(index + 1, name, grouped[index], t)));
    const link = element('a', '', t.evidence);
    link.href = full ? sources.preprodFull : sources.local;
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    steps.append(link);
  }

  $('setupDescription').textContent = full ? t.setupComplete : t.setupPartial;
  const setupList = $('setupReceipts');
  setupList.replaceChildren();
  if (setup && receiptEntries(setup.receipts).length === 3) receiptEntries(setup.receipts).forEach((receipt) => setupList.append(receiptNode(receipt, t)));
  else setupList.append(element('p', '', t.unavailable));
  $('setupEvidenceLink').textContent = t.setupLink;
  $('setupEvidenceLink').href = full ? sources.preprodFullSetup : sources.preprodSetup;
}

if (typeof document !== 'undefined') {
  $('localeToggle').addEventListener('click', () => {
    language = language === 'ko' ? 'en' : 'ko';
    try { localStorage.setItem('fair-launch-locale', language); } catch { /* private mode */ }
    render();
  });
  Promise.allSettled([loadJson(sources.local), loadJson(sources.preprodSetup),
    loadJson(sources.preprodFull), loadJson(sources.preprodFullSetup)]).then(([local, preprod, full, newest]) => {
    localEvidence = local.status === 'fulfilled' ? local.value : null;
    preprodSetup = preprod.status === 'fulfilled' ? preprod.value : null;
    fullEvidence = full.status === 'fulfilled' ? full.value : null;
    fullSetup = newest.status === 'fulfilled' ? newest.value : null;
    render();
  });
}
