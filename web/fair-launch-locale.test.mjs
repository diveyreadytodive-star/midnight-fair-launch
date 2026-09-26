import assert from 'node:assert/strict';
import test from 'node:test';
import { initialLocale, translateText } from './fair-launch-locale.js';

test('browser language is used until an explicit locale choice is stored', () => {
  assert.equal(initialLocale('ko-KR', null), 'ko');
  assert.equal(initialLocale('en-US', null), 'en');
  assert.equal(initialLocale('ko-KR', 'en'), 'en');
  assert.equal(initialLocale('en-US', 'ko'), 'ko');
});

test('visible launch labels round-trip between English and Korean', () => {
  assert.equal(translateText(' Explore fair launches ', 'ko'), ' 공정 출시 탐색 ');
  assert.equal(translateText(' 공정 출시 탐색 ', 'en'), ' Explore fair launches ');
  assert.equal(translateText('Current status not verified', 'ko'), '현재 상태 미검증');
  assert.equal(translateText('등록 영수증과 재고 예치가 확인된 경매만 표시합니다.', 'en'), 'Only auctions with verified deployment and funded inventory are shown.');
});

test('Preprod setup language stays distinct from Local Devnet and returns to English', () => {
  assert.equal(translateText('PREPROD · SETUP VERIFIED', 'ko'), 'PREPROD · 설치 검증');
  assert.equal(translateText('PREPROD · 설치 검증', 'en'), 'PREPROD · SETUP VERIFIED');
  assert.equal(translateText('On-chain commit window', 'ko'), '온체인 입찰 기간');
  assert.equal(translateText('Preprod setup receipts', 'ko'), 'Preprod 설치 영수증');
  assert.equal(translateText('24 hr', 'ko'), '24시간');
  assert.equal(translateText('현재 입찰이 진행 중인 것으로 검증된 테스트넷 경매가 없습니다.', 'en'), 'No verified testnet auctions are currently bidding.');
  assert.match(translateText('Local Devnet 기록 거래 20건의 제한적 원시 패턴 검사에서는 salt·수취인 키의 직접 일치를 찾지 못했습니다. 다른 인코딩이나 간접 추론을 배제하지 않으며 Preprod 거래는 아직 검사하지 않았습니다.', 'en'), /limited raw-pattern scan/);
});

test('counted receipt and inventory labels remain locale-specific', () => {
  assert.equal(translateText('20 recorded transactions', 'ko'), '기록된 거래 20건');
  assert.equal(translateText('기록된 거래 20건', 'en'), '20 recorded transactions');
  assert.equal(translateText('5,000 units', 'ko'), '5,000개');
});
