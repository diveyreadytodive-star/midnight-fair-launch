# Midnight Korea Hackathon 제출폼 초안 — Fair Launch

수정한 6장 PPTX는 `Midnight-Fair-Launch-Submission-v7.pptx`로 별도 저장했다. 필수 Google Slides 공유 링크와 선택 항목인 영상 링크는 아직 비어 있다. 이 문서는 제출 완료 기록이 아니다.

| 항목 | 입력 초안 |
|---|---|
| 팀/프로젝트명 | Midnight Fair Launch |
| 참가 형태 | 개인 참가 |
| 소속/이름 | Luma 신청 정보와 동일하게 직접 입력 |
| 대표자 연락처 | Email 또는 Discord Handle 직접 입력 |
| Github Repository | https://github.com/diveyreadytodive-star/midnight-fair-launch |
| `midnightntwrk` 토픽 | 새 저장소에서 추가·확인 완료 |
| Project Deck | PPTX v7 준비 완료. Google Slides에 업로드하고 보기 권한을 설정한 공유 링크는 아직 미작성 |
| Demo Video | 선택 항목. 미작성 |
| Demo URL | https://diveyreadytodive-star.github.io/midnight-fair-launch/ |
| Academy 증명서 | 보유 중이라고 사용자가 보고함. 제출 시 Explorer/Scholar 파일을 각각 확인해 첨부 |

## 프로젝트 소개

Midnight Fair Launch는 누구나 토큰을 출시하고 누구나 첫 판매에 참여할 수 있는 공개형 런치패드를 지향합니다. 출시 직후의 선착순 매수 대신 일정 시간 입찰을 봉인해 수요를 모으고, 마감 후 낙찰자 모두에게 하나의 청산가격을 적용합니다. 장기적으로는 이 첫 배분 이후 본딩커브 거래로 이어지는 구조를 목표로 합니다.

이를 위해 Midnight의 Compact·영지식 증명으로 최대 매수가와 희망 수량을 공개하지 않은 채 입찰 조건, 예치액, 배정·환불 규칙을 검증합니다. 공개 원장에는 입찰 commitment와 검증된 정산 결과를 남기고, shielded 자산으로 토큰과 환불을 청구하는 구조입니다. **현재 4개 슬롯은 계약 흐름을 검증하기 위한 데모 제한**이며, 제품 목표는 참가자를 4명으로 고정하지 않는 공개 참여형 경매입니다.

## Midnight 구현 포인트

Fair Launch는 선착순 토큰 출시의 초기 가격 선취매·스나이핑, 번들링, 공개 주문 정보를 이용한 프런트러닝을 겨냥해 Midnight 위에 **sealed-bid batch auction**을 구현했습니다. 입찰자의 최대 매수가와 희망 수량을 공개 주문장에 노출하는 대신, Compact 회로가 비공개 입력을 검증하고 낙찰자에게 단일 청산가격을 적용합니다. 이는 입찰 내용을 체인 관찰자에게 감추면서도 정산 규칙은 누구나 확인할 수 있게 하는 Midnight의 선택적 공개 방식입니다.

`registerBid`는 최대 매수가·희망 수량·환불/토큰 수취인·salt를 private opening으로 받고, 최저가·마감시각·고정 예치액 한도와 shielded 결제 코인의 종류·금액을 검사합니다. `persistentCommit`으로 네트워크 도메인·계약 주소·슬롯·입찰 조건·수취인을 salt에 결합해 commitment를 생성하고, 결제 코인은 계약에 shielded escrow로 예치합니다. 공개 원장에는 개별 가격·수량 대신 commitment, 등록 슬롯과 예치 여부가 남습니다.

마감 후 `settle`은 제출된 opening이 기존 commitment와 일치하는지 다시 확인하고, 청산가격보다 높은 수요와 해당 가격 이상의 수요를 비교해 단일가격의 경계를 검증합니다. 높은 가격 입찰의 우선 배정, 정수로 성립하는 경계가격 비례배정, 총 배정량의 재고 한도와 입찰별 예치금 보존을 확인한 뒤 청산가격·배정·환불액을 공개합니다. `claimTokens`·`claimRefund`·`claimProceeds`는 commitment에 묶인 수취인에게 shielded 자산을 보내고 중복 청구를 막습니다. 정산 기한 초과 시 취소·전액 환불 회로도 마련했습니다. **비공개 입찰 조건의 검증, 공개 정산 결과, shielded 자산 이동을 한 계약 흐름에 결합한 점이 Midnight 활용의 핵심**입니다.

## 제출 전 확인

1. 수정 PPTX를 Google Slides에 업로드해 보기 권한이 있는 공유 링크를 만든다. 영상은 선택 항목이다.
2. 사용자의 Luma 이름/이메일/소속, 연락처, 두 Academy 증명서 파일을 직접 확인한다.
3. 공개 데모 URL에서 Explore 4건(Preprod 1건 포함)·상세·Create 미리보기·심사위원 체험·KO/EN 전환이 열리는지 재확인한다. 공개 페이지의 Create·입찰·청구 제출이 비활성이라는 점을 영상과 설명에서 숨기지 않는다.
