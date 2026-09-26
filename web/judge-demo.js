import { DemoInputError, simulateFourSlotAuction } from './fair-launch-demo.js';

const translations = {
  en: {
    skip: 'Skip to content', explore: 'Explore', demoNav: 'Judge demo', simBadge: 'BROWSER SIMULATION',
    eyebrow: 'TRY THE FOUR-SLOT AUCTION', title: 'See what a sealed bid changes',
    intro: 'Choose your private maximum price and quantity. Then reveal the four example bids to see the uniform-price allocation.',
    disclosureTitle: 'Simulation · no chain transaction',
    disclosure: 'This page calculates outcomes in your browser. It never connects a wallet, creates a Compact proof, or submits a transaction. The linked Local Devnet receipts are from a separate recorded run.',
    yourSlot: 'SLOT D · YOUR TEST BID', yourBid: 'Set your maximum',
    fixedRules: 'Test token: 600 for sale · Reserve: 8 TEST · Fixed deposit: 5,000 TEST for each of four slots.',
    maxPrice: 'Maximum TEST per token', quantity: 'Tokens requested', seal: 'Seal example bid',
    sealedMessage: 'Your example bid is sealed locally. The other three values are hidden until you reveal them.',
    reveal: 'Reveal and calculate', reset: 'Try another bid', otherBids: 'THREE EXAMPLE BIDS + YOUR BID',
    resultTitle: 'Auction result', before: 'Other bids are hidden. Set your bid to start.',
    boundary: 'The current contract accepts only four registrations, in arrival order. Its settlement uses one clearing price, but access to a slot is still speed-sensitive. The settlement operator must receive every bid opening. Non-integral pro-rata allocations are rejected.',
    returnExplore: 'Explore recorded launches →', evidence: 'Read the separate Local Devnet evidence ↗',
    footerLeft: 'Fair Launch · browser-only judge demo', footerRight: 'No funds · no wallet · no transaction',
    sealedStatus: 'Bid sealed in this browser. Reveal the examples to calculate the result.',
    settledStatus: 'Calculated in this browser. No proof or transaction was created.',
    unsupportedStatus: 'The current Compact contract would reject this non-integral marginal allocation. It does not silently round or assign leftover units.',
    unsupportedDetail: 'If settlement remains impossible until the opening deadline, the contract allows cancellation and a full refund. This browser simulation does not execute that transaction.',
    clearing: 'Uniform clearing price', slot: 'Slot', max: 'Max price', requested: 'Requested', allocated: 'Allocated', refund: 'Refund',
    proceeds: 'Seller proceeds', unsold: 'Unsold tokens', you: 'You',
    validation: 'Enter whole numbers: price at least 8, quantity at least 1, and price × quantity at most 5,000 TEST.',
  },
  ko: {
    skip: '본문으로 건너뛰기', explore: '탐색', demoNav: '심사위원 체험', simBadge: '브라우저 시뮬레이션',
    eyebrow: '4인 봉인 경매 체험', title: '봉인 입찰의 결과를 직접 확인하세요',
    intro: '나의 최대 매수가와 희망 수량을 정한 뒤 예시 입찰 네 개를 공개해 동일가격 배정 결과를 확인합니다.',
    disclosureTitle: '시뮬레이션 · 새 체인 거래 없음',
    disclosure: '이 페이지는 브라우저에서 결과만 계산합니다. 지갑 연결, Compact 증명, 거래 제출은 하지 않습니다. 링크된 Local Devnet 영수증은 별도의 과거 실행 기록입니다.',
    yourSlot: '슬롯 D · 나의 예시 입찰', yourBid: '최대 조건 입력',
    fixedRules: '판매량 600개 · 최저가 8 TEST · 4개 슬롯에 각 5,000 TEST 고정 예치.',
    maxPrice: '토큰당 최대 매수가 (TEST)', quantity: '희망 토큰 수량', seal: '예시 입찰 봉인',
    sealedMessage: '입찰이 이 브라우저에만 봉인되었습니다. 다른 세 입찰은 공개 버튼을 누를 때까지 숨깁니다.',
    reveal: '공개하고 결과 계산', reset: '다른 입찰 시도', otherBids: '예시 입찰 3개 + 나의 입찰',
    resultTitle: '경매 결과', before: '다른 입찰은 숨겨져 있습니다. 내 입찰을 입력해 시작하세요.',
    boundary: '현재 계약의 4개 등록 슬롯은 도착 순서대로 채워집니다. 정산가격은 같지만 슬롯 참여에는 속도 경쟁이 남습니다. 정산 운영자는 모든 입찰 opening을 받아야 합니다. 나누어떨어지지 않는 경계 비례배정은 거절됩니다.',
    returnExplore: '기록된 출시 탐색 →', evidence: '별도 Local Devnet 영수증 보기 ↗',
    footerLeft: 'Fair Launch · 심사위원 브라우저 체험', footerRight: '자산 이동 없음 · 지갑 없음 · 거래 없음',
    sealedStatus: '이 브라우저에 입찰을 봉인했습니다. 예시 입찰을 공개하면 결과를 계산합니다.',
    settledStatus: '브라우저에서 계산했습니다. 증명이나 거래는 생성하지 않았습니다.',
    unsupportedStatus: '현재 Compact 계약은 이 비정수 경계 배정을 거절합니다. 남은 수량을 임의로 반올림하거나 선착순 배정하지 않습니다.',
    unsupportedDetail: '정산이 opening 마감까지 불가능하면 계약의 취소·전액 환불 경로를 사용할 수 있습니다. 이 브라우저 체험은 그 거래를 실행하지 않습니다.',
    clearing: '동일 청산가격', slot: '슬롯', max: '최대가', requested: '희망량', allocated: '배정량', refund: '환불액',
    proceeds: '판매자 수취액', unsold: '미판매 수량', you: '나',
    validation: '정수로 입력하세요. 최대가는 8 이상, 수량은 1 이상이며 최대가 × 수량은 5,000 TEST 이하여야 합니다.',
  },
};

const presetBids = [{ price: 12, quantity: 300 }, { price: 10, quantity: 300 }, { price: 8, quantity: 300 }];
const $ = (selector) => document.querySelector(selector);
let language = (() => {
  try { return localStorage.getItem('fair-launch-locale') || (navigator.language?.startsWith('ko') ? 'ko' : 'en'); }
  catch { return navigator.language?.startsWith('ko') ? 'ko' : 'en'; }
})();
if (!translations[language]) language = 'en';
let sealedBid = null;

function copy(key) { return translations[language][key]; }
function format(value) { return new Intl.NumberFormat(language === 'ko' ? 'ko-KR' : 'en-US').format(BigInt(value)); }

function applyLanguage() {
  document.documentElement.lang = language;
  document.title = language === 'ko' ? 'Fair Launch · 심사위원 체험' : 'Fair Launch · Judge demo';
  for (const element of document.querySelectorAll('[data-copy]')) element.textContent = copy(element.dataset.copy);
  $('#localeToggle').textContent = language === 'ko' ? 'English' : '한국어';
  $('#localeToggle').setAttribute('aria-label', language === 'ko' ? '영어로 전환' : 'Switch to Korean');
  if (sealedBid && !$('#demoResult').hidden) renderResult();
  else if (sealedBid) $('#demoStatus').textContent = copy('sealedStatus');
}

function cell(tag, text) { const element = document.createElement(tag); element.textContent = text; return element; }

function renderResult() {
  const result = simulateFourSlotAuction({ inventory: 600, reserve: 8, deposit: 5000, bids: [...presetBids, sealedBid] });
  const target = $('#demoResult');
  target.replaceChildren();
  target.hidden = false;
  if (result.status === 'non-integral') {
    $('#demoStatus').textContent = copy('unsupportedStatus');
    target.append(cell('p', copy('unsupportedDetail')));
    return;
  }
  $('#demoStatus').textContent = copy('settledStatus');
  const price = document.createElement('div'); price.className = 'judge-price';
  price.append(cell('span', copy('clearing')), cell('strong', `${format(result.clearingPrice)} TEST`));
  const table = document.createElement('table'); table.className = 'judge-table';
  const head = document.createElement('thead'); const headRow = document.createElement('tr');
  for (const key of ['slot', 'max', 'requested', 'allocated', 'refund']) headRow.append(cell('th', copy(key)));
  head.append(headRow); table.append(head);
  const body = document.createElement('tbody');
  [...presetBids, sealedBid].forEach((bid, index) => {
    const row = document.createElement('tr'); if (index === 3) row.className = 'is-you';
    const values = [index === 3 ? `D · ${copy('you')}` : String.fromCharCode(65 + index), bid.price, bid.quantity, result.allocations[index], `${format(result.refunds[index])} TEST`];
    values.forEach((value, cellIndex) => row.append(cell('td', cellIndex > 0 && cellIndex < 4 ? format(value) : value)));
    body.append(row);
  });
  table.append(body);
  const summary = cell('p', `${copy('proceeds')}: ${format(result.proceeds)} TEST · ${copy('unsold')}: ${format(result.unsold)}`);
  summary.className = 'judge-summary';
  target.append(price, table, summary);
}

$('#localeToggle').addEventListener('click', () => {
  language = language === 'ko' ? 'en' : 'ko';
  try { localStorage.setItem('fair-launch-locale', language); } catch { /* browser storage may be disabled */ }
  applyLanguage();
});
$('#demoForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const price = $('#demoPrice').value.trim();
  const quantity = $('#demoQuantity').value.trim();
  try {
    simulateFourSlotAuction({ inventory: 600, reserve: 8, deposit: 5000, bids: [...presetBids, { price, quantity }] });
    sealedBid = { price, quantity };
    $('#demoValidation').hidden = true;
    $('#demoPrice').disabled = true;
    $('#demoQuantity').disabled = true;
    $('#sealButton').hidden = true;
    $('#sealedStep').hidden = false;
    $('#demoStatus').textContent = copy('sealedStatus');
  } catch (error) {
    if (!(error instanceof DemoInputError)) throw error;
    $('#demoValidation').textContent = copy('validation');
    $('#demoValidation').hidden = false;
  }
});
$('#revealButton').addEventListener('click', () => {
  if (!sealedBid) return;
  renderResult();
  $('#sealedStep').hidden = true;
  $('#resetStep').hidden = false;
});
$('#resetButton').addEventListener('click', () => {
  sealedBid = null;
  $('#demoPrice').disabled = false;
  $('#demoQuantity').disabled = false;
  $('#sealButton').hidden = false;
  $('#resetStep').hidden = true;
  $('#demoResult').hidden = true;
  $('#demoResult').replaceChildren();
  $('#demoStatus').textContent = copy('before');
  $('#demoPrice').focus();
});
applyLanguage();
