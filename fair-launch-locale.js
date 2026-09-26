const pairs = [
  ['Skip to content', '본문으로 건너뛰기'],
  ['Explore', '탐색'], ['Create', '출시'], ['Judge demo', '심사위원 체험'],
  ['Recorded data · Read only', '기록 데이터 · 읽기 전용'],
  ['Create launch', '토큰 출시'], ['Create test launch', '테스트 토큰 출시'],
  ['MIDNIGHT · VERIFIED TEST LAUNCHES', 'MIDNIGHT · 검증된 테스트 출시'],
  ['Explore fair launches', '공정 출시 탐색'],
  ['Only auctions with verified deployment and funded inventory are shown.', '등록 영수증과 재고 예치가 확인된 경매만 표시합니다.'],
  ['Search launches', '출시 검색'], ['Search by name or contract address', '이름 또는 계약 주소 검색'],
  ['For example: Example Token', '예: Example Token'],
  ['Briefly describe the token project.', '토큰 프로젝트에 대해 간단히 설명해 주세요.'],
  ['For example: 600', '예: 600'], ['For example: 8', '예: 8'],
  ['For example: 5,000', '예: 5,000'], ['At least 5', '최소 5'],
  ['Main navigation', '주요 메뉴'], ['Auction status filters', '경매 상태 필터'],
  ['Verified launch list', '검증된 출시 목록'],
  ['Try a sealed-bid auction', '봉인 입찰 경매 체험'],
  ['Change your example bid, then see the uniform clearing price. Browser simulation only — no wallet, proof, or new transaction.', '예시 입찰을 바꿔 동일 청산가격을 확인하세요. 브라우저 시뮬레이션이며 지갑·증명·새 거래는 없습니다.'],
  ['Try judge demo →', '심사위원 체험 →'],
  ['All', '전체'], ['Upcoming', '예정'], ['Live', '진행 중'], ['Settled', '정산 완료'],
  ['Loading verified launches…', '검증된 출시 정보를 불러오는 중입니다.'],
  ['No launches to show', '표시할 출시가 없습니다'],
  ['No verified auctions match this filter.', '선택한 조건에 맞는 검증된 경매가 아직 없습니다.'],
  ['Clear filters', '필터 초기화'],
  ['Only receipt-verified test launches · No market cap or trading data', '영수증이 검증된 테스트 출시만 표시 · 시가총액·거래 데이터 없음'],
  ['20 recorded Local Devnet transactions', '기록된 20개 Local Devnet 거래'],
  ['LOCAL DEVNET · OPERATOR-SPONSORED', 'LOCAL DEVNET · 운영자 대리 서명'],
  ['Create a test launch', '테스트 토큰 출시'],
  ['Enter settings to preview the auction card.', '설정을 입력하고 경매 카드가 어떻게 보일지 미리 확인합니다.'],
  ['TEST ASSETS ONLY', '테스트 자산만 사용'],
  ['Operator-sponsored demo.', '운영자 대리 서명 데모.'],
  ['The Local Devnet operator key mints the test token and funds inventory. Your wallet does not sign; this is not a permissionless launch. TEST has no value.', 'Local Devnet 운영자 키가 테스트 토큰을 발행하고 재고를 예치합니다. 사용자의 지갑이 서명하지 않으며, permissionless launch가 아닙니다. TEST 자산은 가치가 없습니다.'],
  ['Token details', '토큰 정보'], ['Preview metadata only.', '미리보기용 메타데이터입니다.'],
  ['Token name', '토큰 이름'], ['Required', '필수'], ['Ticker', '티커'],
  ['Maximum 10 characters. The preview uses uppercase.', '최대 10자. 티커는 미리보기에서 대문자로 표시됩니다.'],
  ['Image URL', '이미지 URL'], ['Optional', '선택'],
  ['Only HTTPS image URLs appear in the preview. Images are not uploaded or stored on-chain.', 'HTTPS 이미지 주소만 미리보기에 표시됩니다. 업로드되거나 체인에 저장되지는 않습니다.'],
  ['Description', '설명'], ['Auction configuration', '경매 설정'],
  ['These are integer TEST units for the demo.', '정수 TEST 단위의 시연 설정입니다.'],
  ['Sale inventory', '판매 수량'], ['tokens', '토큰'], ['Reserve price', '최저가격'],
  ['Deposit lot', '고정 예치액'], ['Commit window', '입찰 기간'], ['Open window', 'opening 기간'],
  ['minutes', '분'], ['At least 5 minutes for local deploy, mint, and inventory funding.', '로컬 배포·발행·예치 작업을 위한 최소 5분'],
  ['The current chain experiment has four fixed bidder slots. Creator allocation and liquidity options are unavailable.', '현재 체인 실험은 네 개의 고정 입찰 슬롯을 사용합니다. 창작자 물량과 유동성 옵션은 지원하지 않습니다.'],
  ['Preview only until the Local Devnet Create API is connected.', '실제 Local Devnet Create API가 연결되기 전까지 초안만 만들 수 있습니다.'],
  ['LIVE PREVIEW', '실시간 미리보기'], ['Launch card', '출시 카드'], ['DRAFT', '초안'],
  ['DRAFT · NOT DEPLOYED', '초안 · 미배포'], ['Your token name', '토큰 이름'],
  ['Your token description appears here.', '토큰 설명을 입력하면 여기에 표시됩니다.'], ['Not set', '미입력'],
  ['This preview updates only in your browser. The launch appears in Explore only after deploy, mint and funding receipts are verified.', '이 미리보기는 브라우저 메모리에서만 갱신됩니다. Explore 목록에는 배포·발행·예치 영수증을 확인한 뒤에만 나타납니다.'],
  ['VERIFIED LOCAL DEVNET LAUNCH', '검증된 LOCAL DEVNET 출시'], ['Unlabeled test token', '이름 없는 테스트 토큰'],
  ['Contract', '계약'], ['Copy', '복사'], ['Copied', '복사됨'], ['Copy unavailable', '복사 불가'],
  ['Token name, ticker and image metadata were not available for this contract.', '이 계약에서 토큰 이름, 티커, 이미지 메타데이터를 읽지 못했습니다.'],
  ['Auction settled', '경매 정산 완료'], ['AUCTION OUTCOME', '경매 결과'], ['Settlement record', '정산 기록'],
  ['RECORDED', '기록됨'], ['VERIFIED', '검증됨'], ['Clearing price', '청산가격'],
  ['TEST per sale token', '토큰당 TEST'], ['Registered slots', '등록 슬롯'], ['Recorded receipts', '기록된 영수증'],
  ['Slot results are included because this auction has already settled; they are public settlement data.', '이 경매는 정산되어 슬롯별 결과가 공개돼 있습니다.'],
  ['PARTICIPATE', '참여'], ['Auction actions', '경매 동작'],
  ['This auction is settled. No wallet connection or personal claim status is available on this page.', '이 경매는 정산되었습니다. 이 화면에는 지갑 연결이나 개인 청구 상태 조회가 없습니다.'],
  ['Bid · auction settled', '입찰 · 경매 종료'], ['Claim tokens · wallet unavailable', '토큰 청구 · 지갑 기능 준비 중'],
  ['Claim refund · wallet unavailable', '환불 청구 · 지갑 기능 준비 중'],
  ['Personal bids and claims will activate only after the browser wallet adapter is verified.', '실제 개인 입찰·청구는 검증된 브라우저 지갑 어댑터가 준비된 뒤에만 활성화됩니다.'],
  ['EVIDENCE', '증거'], ['Local Devnet record', 'Local Devnet 기록'],
  ['Showing saved results read-only.', '저장된 실행 결과를 읽기 전용으로 표시합니다.'],
  ['Read recorded evidence', '기록된 증거 읽기'], ['Privacy and test-network disclosure', '프라이버시와 테스트 네트워크 범위'],
  ['Registered slots, commitment hashes and fixed deposits are public. After settlement, the clearing price, each slot’s allocation, refund and claim status are public. The fixed deposit may reveal a charge and allocated quantity.', '등록 슬롯, commitment hash, 고정 deposit은 공개됩니다. 정산 뒤에는 clearing price, 슬롯별 allocation/refund와 claim 상태도 공개되며, 고정 deposit으로부터 charge와 수량을 추론할 수 있습니다.'],
  ['The settlement operator receives every registered bid opening and can see maximum prices, quantities, recipients, and salts. The four slots fill in registration order.', '정산 운영자는 등록된 모든 입찰의 opening을 받아야 하므로 최대가격·수량·수취인·salt를 볼 수 있습니다. 네 개 슬롯은 등록 순서대로 채워집니다.'],
  ['A limited raw-pattern scan of 20 recorded Local Devnet transactions found no exact salt or recipient-key matches. It does not rule out other encodings or inference; Preprod transactions have not been audited.', 'Local Devnet 기록 거래 20건의 제한적 원시 패턴 검사에서는 salt·수취인 키의 직접 일치를 찾지 못했습니다. 다른 인코딩이나 간접 추론을 배제하지 않으며 Preprod 거래는 아직 검사하지 않았습니다.'],
  ['All assets are valueless Local Devnet test assets. There is no bonding curve, DEX/LP trading, market value or production token in this MVP.', '모든 자산은 가치가 없는 Local Devnet 테스트 자산입니다. 이 MVP에는 bonding curve, DEX/LP 거래, 시장가치, production token이 없습니다.'],
  ['Verified launch not found', '검증된 출시를 찾을 수 없습니다'],
  ['This contract is not in the receipt-verified catalog.', '이 계약은 영수증이 확인된 카탈로그에 없습니다.'],
  ['Explore launches', '출시 탐색'],
  ['Fair Launch · Local Devnet test experience', 'Fair Launch · Local Devnet 테스트 체험'],
  ['Fair Launch · Test network experience', 'Fair Launch · 테스트 네트워크 체험'],
  ['Not a live market or production token launch', '실거래 시장이나 프로덕션 토큰 출시가 아닙니다'],
  ['Wallet read-only preview', '지갑 읽기 전용 연결'],
  ['Connect wallet', '지갑 연결'], ['Check wallet', '지갑 확인'],
  ['Select Midnight wallet', 'Midnight 지갑 선택'],
  ['Network:', '네트워크:'], ['Midnight wallet and proof setup ↗', 'Midnight 지갑·증명 설정 ↗'],
  ['Recorded slot settlement outcomes', '기록된 슬롯별 정산 결과'],
  ['This connection reads Preprod network and DUST status only. It cannot submit Fair Launch bids or claims yet.', 'Preprod 네트워크와 DUST 상태만 읽습니다. Fair Launch 입찰·청구 거래는 아직 제출할 수 없습니다.'],
  ['Install a Preprod-compatible Midnight wallet to try this connection.', '연결을 시험하려면 Preprod를 지원하는 Midnight 지갑을 설치하세요.'],
  ['Close', '닫기'],
  ['Final status not recorded', '최종 상태 기록 없음'],
  ['Current status not verified', '현재 상태 미검증'],
  ['Bidding live', '입찰 진행 중'], ['Opening window', 'opening 기간'],
  ['Settlement pending', '정산 대기'], ['Cancelled', '취소됨'], ['Status unavailable', '상태 확인 불가'],
  ['LOCAL DEVNET', 'LOCAL DEVNET'], ['RECORDED LOCAL DEVNET', '기록된 LOCAL DEVNET'],
  ['PREPROD · SETUP VERIFIED', 'PREPROD · 설치 검증'],
  ['Metadata not anchored', '메타데이터 미고정'], ['No ticker', '티커 없음'],
  ['Reserve', '최저가격'], ['Deposit lot', '고정 예치액'], ['View auction →', '경매 보기 →'],
  ['3 setup receipts verified', '준비 거래 3건 검증'],
  ['No verified launches match this search.', '검색어와 일치하는 검증된 출시가 없습니다.'],
  ['No verified live auctions are available.', '진행 중인 검증된 경매가 없습니다.'],
  ['No verified upcoming auctions are available.', '예정된 검증 경매가 없습니다.'],
  ['No verified settled auctions match this filter.', '조건에 맞는 정산 완료 경매가 없습니다.'],
  ['No live auctions yet', '진행 중인 경매 없음'], ['No upcoming auctions yet', '예정된 경매 없음'],
  ['No settled auctions found', '정산 완료 경매 없음'], ['No search results', '검색 결과 없음'],
  ['No verified launches match your search or contract address.', '검색어나 계약 주소와 일치하는 검증된 출시가 없습니다.'],
  ['No verified Local Devnet auctions are currently bidding.', '현재 입찰이 진행 중인 것으로 검증된 Local Devnet 경매가 없습니다.'],
  ['No verified Local Devnet auctions are currently upcoming.', '현재 입찰 예정 상태로 검증된 Local Devnet 경매가 없습니다.'],
  ['No verified testnet auctions are currently bidding.', '현재 입찰이 진행 중인 것으로 검증된 테스트넷 경매가 없습니다.'],
  ['No verified testnet auctions are currently upcoming.', '현재 입찰 예정 상태로 검증된 테스트넷 경매가 없습니다.'],
  ['No receipt-verified auctions match this filter.', '선택한 조건에 맞는 영수증 검증 경매가 없습니다.'],
  ['Operator demo · Local Devnet', '운영자 데모 · Local Devnet'],
  ['Verified catalog · Local Devnet', '검증된 목록 · Local Devnet'],
  ['Operator-sponsored Local Devnet test mode is ready. The operator signs mint and funding actions; this is not a user-wallet or permissionless launch.', '운영자 대리 서명 Local Devnet 모드가 준비되었습니다. 운영자가 발행·예치를 서명하며 사용자 지갑의 permissionless 출시는 아닙니다.'],
  ['Operator-sponsored Local Devnet mode is connected, but Create is currently disabled by the backend.', '운영자 Local Devnet에 연결됐지만 백엔드에서 Create를 비활성화했습니다.'],
  ['The verified Local Devnet catalog is available. This backend mode does not expose operator Create.', '검증된 Local Devnet 목록은 볼 수 있지만 이 백엔드는 운영자 Create를 제공하지 않습니다.'],
  ['Draft preview only. Create activates only when the Local Devnet operator API explicitly reports canCreate=true.', '초안 미리보기만 가능합니다. Local Devnet 운영자 API가 canCreate=true를 반환해야 실제 Create가 활성화됩니다.'],
  ['This backend mode does not support Create. Draft preview only.', '현재 백엔드 모드는 Create를 지원하지 않습니다. 초안 미리보기만 사용할 수 있습니다.'],
  ['Loading receipt-verified launches…', '영수증이 검증된 출시 정보를 불러오는 중…'],
  ['Showing one recorded Local Devnet launch. No write API is connected.', '기록된 Local Devnet 출시 1개를 표시합니다. 쓰기 API는 연결되지 않았습니다.'],
  ['Launch data could not be loaded. No unverified cards are shown.', '출시 데이터를 불러오지 못했습니다. 검증되지 않은 카드는 표시하지 않습니다.'],
  ['Some catalog entries were omitted because deploy, mint, or funding receipts were incomplete.', '배포·발행·예치 영수증이 불완전한 목록 항목은 제외했습니다.'],
  ['No verified launches yet', '검증된 출시 없음'],
  ['No launches have verified deployment, mint and inventory funding receipts yet.', '배포, 토큰 발행, 재고 예치 영수증이 확인된 출시가 아직 없습니다.'],
  ['RECORDED MIDNIGHT LOCAL DEVNET LAUNCH', '기록된 MIDNIGHT LOCAL DEVNET 출시'],
  ['VERIFIED MIDNIGHT LOCAL DEVNET LAUNCH', '검증된 MIDNIGHT LOCAL DEVNET 출시'],
  ['MIDNIGHT PREPROD · SETUP VERIFIED', 'MIDNIGHT PREPROD · 설치 검증'],
  ['Preprod setup receipts', 'Preprod 설치 영수증'],
  ['This token is a valueless Preprod test asset. This MVP has no bonding curve, DEX/LP trading, market cap, or production token.', '이 토큰은 가치가 없는 Preprod 테스트 자산입니다. 이 MVP에는 본딩커브, DEX/LP 거래, 시가총액, 프로덕션 토큰이 없습니다.'],
  ['Metadata hash is anchored to this contract.', '메타데이터 해시가 계약에 고정되었습니다.'],
  ['This test token has no contract-bound name, ticker or image metadata.', '계약에 이름, 티커, 이미지 메타데이터가 연결되지 않은 테스트 토큰입니다.'],
  ['AUCTION CONFIGURATION', '경매 설정'], ['Auction rules', '경매 규칙'], ['Not settled', '미정산'],
  ['Not live-verified', '실시간 미검증'],
  ['Not in catalog', '목록에 없음'], ['Not in record', '기록 없음'],
  ['Slot', '슬롯'], ['Allocated', '배정'], ['Refund', '환불'],
  ['Slot outcomes are public settlement data for this completed auction.', '슬롯별 결과는 정산 완료 후 공개되는 데이터입니다.'],
  ['Settlement has not been recorded for this launch; no clearing price or slot outcome is shown.', '이 출시는 정산 기록이 없어 청산가격과 슬롯별 결과를 표시하지 않습니다.'],
  ['Preprod setup receipts are verified. Current auction phase and slot state need live chain readback.', 'Preprod 설치 영수증은 검증됐습니다. 현재 경매 단계와 슬롯 상태는 실시간 체인 조회가 필요합니다.'],
  ['Bid · auction cancelled', '입찰 · 경매 취소'], ['Bid closed · opening window', '입찰 종료 · opening 기간'],
  ['Bid · not open yet', '입찰 · 아직 시작 전'], ['Bid · wallet unavailable', '입찰 · 지갑 거래 미지원'],
  ['This auction has ended. This is a recorded view and does not read your personal wallet status.', '이 경매는 종료되었습니다. 이 페이지는 개인 지갑 상태를 조회하지 않는 기록용 화면입니다.'],
  ['Auction state comes from the verified catalog. The Preprod wallet connection is read-only and cannot submit a bid to this Local Devnet auction.', '경매 상태는 검증된 카탈로그에서 읽었습니다. Preprod 지갑 연결은 읽기 전용이며 이 Local Devnet 경매에 입찰을 제출할 수 없습니다.'],
  ['Only the Preprod setup receipts have been verified. Bidding and claims remain unavailable until current chain state and wallet signing are verified.', 'Preprod 경매의 설치 영수증만 확인되었습니다. 현재 체인 상태와 사용자 지갑 서명 경로가 검증될 때까지 입찰·청구를 사용할 수 없습니다.'],
  ['View 20 recorded Local Devnet transactions and final wallet readback. This file is saved evidence, not a live query.', '20개의 기록된 Local Devnet 거래와 최종 지갑 readback을 볼 수 있습니다. 이 파일은 저장된 증거이며 실시간 조회가 아닙니다.'],
  ['This launch has a recorded evidence document.', '이 출시의 기록된 증거 문서입니다.'],
  ['The catalog includes verified deployment, mint and inventory-funding receipts.', '배포·발행·예치 확인 영수증은 카탈로그 응답에 포함되어 있습니다.'],
  ['The operator Create API is unavailable. Draft preview only.', 'Operator Create API가 실행 가능한 상태가 아닙니다. 초안 미리보기만 사용할 수 있습니다.'],
  ['Creating test launch…', '테스트 토큰 출시 중…'],
  ['Processing operator-sponsored Local Devnet Create request.', 'Operator-sponsored Local Devnet Create 요청을 처리 중입니다.'],
  ['Chain actions are incomplete. Do not add to Explore until recovery is checked.', '체인 작업이 완료되지 않았습니다. 복구 상태를 확인하기 전까지 목록에 추가하지 않습니다.'],
  ['New Create requests are disabled until operator recovery is checked.', '복구 확인 전까지 새 Create 요청을 보낼 수 없습니다. 운영자 확인이 필요합니다.'],
  ['Deploy, mint and inventory funding receipts are not all verified. This launch was not added to Explore.', 'Create 결과에 배포·발행·재고 예치 영수증이 모두 확인되지 않았습니다. Explore 목록에는 추가하지 않았습니다.'],
  ['Deployment, mint and inventory funding receipts are confirmed. Opening the verified launch.', '배포, 발행, 재고 예치 영수증이 확인되었습니다. 검증된 출시를 열었습니다.'],
  ['Could not complete the Create request.', 'Create 요청을 완료하지 못했습니다.'],
  ['Draft remains in this tab. Check the server response before retrying.', '초안은 이 탭에서만 유지됩니다. 서버 응답을 확인한 뒤 다시 시도할 수 있습니다.'],
];

const enToKo = new Map(pairs);
const koToEn = new Map(pairs.map(([en, ko]) => [ko, en]));
const localeKey = 'fair-launch-locale';

export function initialLocale(browserLanguage, stored) {
  if (stored === 'ko' || stored === 'en') return stored;
  return String(browserLanguage ?? '').toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

export function translateText(value, language) {
  const source = String(value ?? '');
  const trimmed = source.trim();
  const replacement = language === 'ko' ? enToKo.get(trimmed) : koToEn.get(trimmed);
  if (!replacement || replacement === trimmed) {
    const generated = translateGenerated(trimmed, language);
    if (!generated || generated === trimmed) return source;
    const leading = source.match(/^\s*/)?.[0] ?? '';
    const trailing = source.match(/\s*$/)?.[0] ?? '';
    return leading + generated + trailing;
  }
  const leading = source.match(/^\s*/)?.[0] ?? '';
  const trailing = source.match(/\s*$/)?.[0] ?? '';
  return leading + replacement + trailing;
}

function translateGenerated(value, language) {
  const patterns = language === 'ko' ? [
    [/^(\d+) verified launches? · (live verified catalog|recorded evidence) · read-only unless Create API is enabled$/, (_, count, kind) => `${count}개 검증된 출시 · ${kind === 'recorded evidence' ? '기록된 증거' : '실시간 검증 목록'} · Create API 없이는 읽기 전용`],
    [/^Showing (\d+) recorded Local Devnet launches\. Create requires the local operator API\.$/, (_, count) => `기록된 Local Devnet 출시 ${count}개를 표시합니다. 실제 출시는 로컬 운영자 API가 필요합니다.`],
    [/^(\d+) verified test launches · Preprod setup only, current status unverified · public writes unavailable$/, (_, count) => `${count}개 검증된 테스트 출시 · Preprod 설치만 확인, 현재 상태 미검증 · 공개 쓰기 기능 없음`],
    [/^(\d+) recorded transactions$/, (_, count) => `기록된 거래 ${count}건`],
    [/^([\d,]+) units$/, (_, count) => `${count}개`],
    [/^(\d+) transactions$/, (_, count) => `거래 ${count}건`],
    [/^Slot (\d+)$/, (_, count) => `슬롯 ${count}`],
    [/^(\d+) min$/, (_, count) => `${count}분`],
    [/^(\d+) hr$/, (_, count) => `${count}시간`],
  ] : [
    [/^(\d+)개 검증된 출시 · (실시간 검증 목록|기록된 증거) · Create API 없이는 읽기 전용$/, (_, count, kind) => `${count} verified launch${count === '1' ? '' : 'es'} · ${kind === '기록된 증거' ? 'recorded evidence' : 'live verified catalog'} · read-only unless Create API is enabled`],
    [/^기록된 Local Devnet 출시 (\d+)개를 표시합니다\. 실제 출시는 로컬 운영자 API가 필요합니다\.$/, (_, count) => `Showing ${count} recorded Local Devnet launches. Create requires the local operator API.`],
    [/^(\d+)개 검증된 테스트 출시 · Preprod 설치만 확인, 현재 상태 미검증 · 공개 쓰기 기능 없음$/, (_, count) => `${count} verified test launches · Preprod setup only, current status unverified · public writes unavailable`],
    [/^기록된 거래 (\d+)건$/, (_, count) => `${count} recorded transactions`],
    [/^([\d,]+)개$/, (_, count) => `${count} units`],
    [/^거래 (\d+)건$/, (_, count) => `${count} transactions`],
    [/^슬롯 (\d+)$/, (_, count) => `Slot ${count}`],
    [/^(\d+)분$/, (_, count) => `${count} min`],
    [/^(\d+)시간$/, (_, count) => `${count} hr`],
  ];
  for (const [pattern, render] of patterns) {
    const match = value.match(pattern);
    if (match) return render(...match);
  }
  return null;
}

export function createLocaleController(doc = document, storage = localStorage, browserLanguage = navigator.language) {
  let stored;
  try { stored = storage.getItem(localeKey); } catch { /* storage can be unavailable */ }
  let language = initialLocale(browserLanguage, stored);
  const originalText = new WeakMap();
  const originalAttributes = new WeakMap();

  function translateNode(node) {
    if (node.nodeType !== 3) return;
    if (node.parentElement?.closest('script, style, #localeToggle')) return;
    let record = originalText.get(node);
    if (!record || node.nodeValue !== record.lastOutput) {
      record = { source: node.nodeValue, lastOutput: node.nodeValue };
      originalText.set(node, record);
    }
    const next = translateText(record.source, language);
    record.lastOutput = next;
    if (next !== node.nodeValue) node.nodeValue = next;
  }

  function translateTree(root) {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) translateNode(node);
    for (const element of root.querySelectorAll?.('[placeholder], [aria-label]') ?? []) {
      let record = originalAttributes.get(element);
      if (!record) { record = new Map(); originalAttributes.set(element, record); }
      for (const attribute of ['placeholder', 'aria-label']) {
        if (!element.hasAttribute(attribute)) continue;
        const value = element.getAttribute(attribute);
        if (!record.has(attribute) || value !== record.get(attribute).lastOutput) {
          record.set(attribute, { source: value, lastOutput: value });
        }
        const sourceRecord = record.get(attribute);
        const next = translateText(sourceRecord.source, language);
        sourceRecord.lastOutput = next;
        if (next !== element.getAttribute(attribute)) element.setAttribute(attribute, next);
      }
    }
  }

  function apply() {
    doc.documentElement.lang = language;
    doc.title = language === 'ko' ? 'Fair Launch · 탐색' : 'Fair Launch · Explore';
    const toggle = doc.querySelector('#localeToggle');
    if (toggle) {
      toggle.textContent = language === 'ko' ? 'EN' : 'KO';
      toggle.setAttribute('aria-label', language === 'ko' ? '영어로 전환' : 'Switch to Korean');
    }
    translateTree(doc.body);
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') translateNode(record.target);
      for (const node of record.addedNodes ?? []) {
        if (node.nodeType === 3) translateNode(node);
        else if (node.nodeType === 1) translateTree(node);
      }
    }
  });
  observer.observe(doc.body, { subtree: true, childList: true, characterData: true });
  doc.querySelector('#localeToggle')?.addEventListener('click', () => {
    language = language === 'ko' ? 'en' : 'ko';
    try { storage.setItem(localeKey, language); } catch { /* storage can be unavailable */ }
    apply();
  });
  apply();
  return { get language() { return language; }, apply, disconnect() { observer.disconnect(); } };
}
