# Midnight Korea Hackathon 제출폼 초안 — Fair Launch

영상·Google Slides 링크는 사용자가 제작을 보류했으므로 비워 둔다. 이 문서는 제출 완료 기록이 아니다.

| 항목 | 입력 초안 |
|---|---|
| 팀/프로젝트명 | Midnight Fair Launch |
| 참가 형태 | 개인 참가 |
| 소속/이름 | Luma 신청 정보와 동일하게 직접 입력 |
| 대표자 연락처 | Email 또는 Discord Handle 직접 입력 |
| Github Repository | https://github.com/diveyreadytodive-star/midnight-fair-launch |
| `midnightntwrk` 토픽 | 새 저장소에서 추가·확인 완료 |
| Project Deck | Google Slides 링크 미작성 |
| Demo Video | 미작성 |
| Demo URL | https://diveyreadytodive-star.github.io/midnight-fair-launch/ |
| Academy 증명서 | 보유 중이라고 사용자가 보고함. 제출 시 Explorer/Scholar 파일을 각각 확인해 첨부 |

## 프로젝트 소개

Fair Launch는 새 밈토큰의 첫 판매를 선착순 매수 대신 **봉인 입찰·동일가격 정산**으로 진행하는 Midnight DApp MVP입니다. 창작자는 테스트 토큰 이름과 경매 재고·최저가격·예치액·입찰 시간을 정합니다. Explore에는 배포·발행·재고 예치가 확인된 출시만 표시하며, 토큰 상세에서 경매 규칙과 결과를 봅니다. 매수자는 최대 단가와 희망 수량을 입찰하고, 마감 뒤 모든 등록 입찰을 같은 규칙으로 처리합니다. 낙찰자는 토큰을, 낙찰자와 탈락자는 미사용 결제 자산을 각각 청구합니다.

가치 없는 Local Devnet 자산으로 4인 경매의 **배포→입찰 4건→청산가 10 정산→환불 4건→판매대금 2건→토큰 2건**을 포함한 20개 거래를 확정했습니다. 판매량 600개는 300/300/0/0개로 배정됐고, 각 지갑의 환불·토큰 잔고와 판매자 대금 6,000 TEST를 확인했습니다. 별도의 두 테스트 토큰도 Create 흐름으로 배포·발행·예치해 Explore에 등록했습니다. 공개 웹 데모는 기록된 출시의 검색·상세와 Create 초안 미리보기를 제공하며, 실제 Create는 로컬 운영자 데모 서버에서만 작동합니다.

## Midnight 구현 포인트

Compact의 `registerBid`는 참가자의 최대 단가·희망 수량·수취인·salt를 private input으로 받아 예치 한도와 조건을 검사하고 공개 원장에는 입찰 commitment와 등록 슬롯을 남깁니다. `settle`은 마감 시 등록된 최대 4건의 opening을 모두 검증합니다. 청산가격의 수요 경계, 높은 입찰의 전량 배정, 경계가격의 정수 비례 배정, 판매량·예치금 보존을 증명한 뒤 청산가격과 슬롯별 배정·환불액을 공개합니다. `claimRefund`, `claimTokens`, `claimProceeds`는 shielded 테스트 자산을 각 수취인이 따로 청구하며 중복 청구를 막습니다.

프라이버시가 필요한 이유는 첫 판매 중 개별 최대 매수가와 수량이 공개되면 다른 참여자가 이를 보고 순서를 바꾸거나 입찰을 맞출 수 있기 때문입니다. 공개 범위도 분명합니다. 고정 예치액·등록 시각·commitment는 공개되고, 정산 후 청산가격·슬롯별 배정·환불과 청구 상태도 공개됩니다. 정산 운영자는 입찰 opening을 알 수 있습니다. 원시 거래 인코딩의 누출 여부는 아직 감사하지 않았으므로 완전 익명성이나 영구적인 수량 비공개를 주장하지 않습니다. 이번 구현은 **4인 Local Devnet 테스트 자산**, 정수로 나눠떨어지는 경계 배정, 운영자 서명 Create에 한정되며 본딩커브·사용자 브라우저 지갑 입찰/청구는 포함되지 않습니다.

## 제출 전 확인

1. 영상·Google Slides 링크를 준비한 뒤 설명이 실제 기능 범위를 넘지 않는지 검토한다.
2. 사용자의 Luma 이름/이메일/소속, 연락처, 두 Academy 증명서 파일을 직접 확인한다.
3. 공개 데모 URL에서 Explore 3건·상세·Create 미리보기가 열리는지 재확인한다. 공개 페이지의 Create 제출 버튼이 비활성이라는 점을 영상과 설명에서 숨기지 않는다.
