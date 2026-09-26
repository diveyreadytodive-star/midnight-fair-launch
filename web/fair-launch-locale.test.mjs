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
  assert.equal(translateText('Final status not recorded', 'ko'), '최종 상태 기록 없음');
  assert.equal(translateText('등록 영수증과 재고 예치가 확인된 경매만 표시합니다.', 'en'), 'Only auctions with verified deployment and funded inventory are shown.');
});

test('counted receipt and inventory labels remain locale-specific', () => {
  assert.equal(translateText('20 recorded transactions', 'ko'), '기록된 거래 20건');
  assert.equal(translateText('기록된 거래 20건', 'en'), '20 recorded transactions');
  assert.equal(translateText('5,000 units', 'ko'), '5,000개');
});
