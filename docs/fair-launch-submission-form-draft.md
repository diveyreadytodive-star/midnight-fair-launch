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

Compact의 `registerBid`는 참가자의 최대 단가·희망 수량·수취인·salt를 private input으로 받아 예치 한도와 조건을 검사하고 공개 원장에는 입찰 commitment와 등록 슬롯을 남깁니다. `settle`은 마감 시 등록된 최대 4건의 opening을 모두 검증합니다. 청산가격의 수요 경계, 높은 입찰의 전량 배정, 경계가격의 **나눠떨어지는 경우에 한한** 정수 비례 배정, 판매량·예치금 보존을 증명한 뒤 청산가격과 슬롯별 배정·환불액을 공개합니다. 비정수 경계 배정은 현재 거절됩니다. `claimRefund`, `claimTokens`, `claimProceeds`는 shielded 테스트 자산을 각 수취인이 따로 청구하며 중복 청구를 막습니다. 정산 기한이 지나면 취소·전액 환불 경로가 있습니다.

프라이버시가 필요한 이유는 첫 판매 중 개별 최대 매수가와 수량이 공개되면 다른 참여자가 이를 보고 입찰을 맞출 수 있기 때문입니다. 공개 범위도 분명합니다. 고정 예치액·등록 시각·commitment는 공개되고, 정산 후 청산가격·슬롯별 배정·환불과 청구 상태도 공개됩니다. 정산 운영자는 모든 입찰 opening을 알 수 있습니다. [원시 거래의 제한된 직접 패턴 검사](evidence/fair-launch-targeted-raw-scan.md)에서는 Local Devnet 거래 20건에서 salt와 수취인 키의 정확한 32바이트 패턴을 찾지 못했지만, 다른 인코딩이나 간접 추론까지 배제하는 감사는 아닙니다. Preprod 원시 거래의 프라이버시는 아직 검사하지 않았습니다. 완전 익명성이나 영구적인 수량 비공개를 주장하지 않습니다. 이번 구현은 **4인 Local Devnet 완료 경매와 Preprod 운영자 서명 입찰 등록 4건**까지 확인했습니다. 공개 브라우저에서 발행·입찰 회로 파일 6개의 무결성도 확인했지만 실제 지갑 증명은 아직 생성하지 않았습니다. 본딩커브·사용자 브라우저 지갑 입찰/청구는 포함되지 않습니다.

## 제출 전 확인

1. 수정 PPTX를 Google Slides에 업로드해 보기 권한이 있는 공유 링크를 만든다. 영상은 선택 항목이다.
2. 사용자의 Luma 이름/이메일/소속, 연락처, 두 Academy 증명서 파일을 직접 확인한다.
3. 공개 데모 URL에서 Explore 4건(Preprod 1건 포함)·상세·Create 미리보기·심사위원 체험·KO/EN 전환이 열리는지 재확인한다. 공개 페이지의 Create·입찰·청구 제출이 비활성이라는 점을 영상과 설명에서 숨기지 않는다.
