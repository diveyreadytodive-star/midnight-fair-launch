# VeilIntent — Midnight Korea Hackathon 제출폼 초안

**상태: 제출 전 초안.** `codex/veil-intent` 브랜치의 실제 Local Devnet 증거를 기준으로 쓴다. 별도 공개 저장소 `veil-intent`의 기본 `main`에 웹·덱·증거를 반영하고 `midnightntwrk` 토픽을 확인했다. 기본 빌드 명령을 고친 뒤 새 폴더에서 `npm ci`(취약점 0), 자체 Compact 설치, `npm test`의 SILENCE 3회로·VeilIntent 7회로 컴파일/타입 검사, **60+14개 테스트**를 통과했다. 이후 새 커밋이 생기면 최종 fresh clone을 다시 확인한다. Google Slides·영상·실제 폼 영수증은 아직 없다.

## Team / Project Name

VeilIntent — Private Policy-Bound Payments on Midnight

## Participation Type / Affiliation / Name / Contact

**실제 Luma 신청 내역과 대표 연락처 확인 필요.** 이름·이메일·소속·Discord를 추정해 쓰지 않는다. 현재 1인 개발 기준으로 설계했다.

## Public GitHub Repository

https://github.com/diveyreadytodive-star/veil-intent

공개 저장소의 기본 `main`이 VeilIntent 체크포인트를 가리키고 Topics의 `midnightntwrk`, `compact`, `privacy`를 확인했다. 제출 직전에도 기본 checkout의 최신 코드가 이 문안과 같은지 재확인한다.

## Project Overview

AI agent에게 지갑 전체 권한을 주지 않으면서 구매를 맡기려면, 지출 조건을 누가 강제하는지가 중요합니다. 한편 최대 허용 가격과 예산을 온체인에 공개하면 판매자와 관찰자가 구매자의 협상 한도를 알 수 있습니다. VeilIntent는 구매자가 테스트 자금을 계약에 맡기고 agent에게 한 intent에 한정된 권한을 부여합니다. 판매자는 실제 수량과 가격의 견적을 제출하고, agent 측 prover는 공개하지 않은 최대 단가·총액 조건에 그 견적이 맞는지 Compact proof로 검증합니다. 승인된 견적만 허가된 판매자가 자기 shielded 지갑으로 청구할 수 있고, 구매자는 남은 자금을 별도로 회수합니다.

이번 해커톤 MVP는 구매자 1명, 허가 판매자 1명, 견적 1개, 가치 없는 단일 테스트 결제 토큰을 사용합니다. 공개 고정 예치액은 150, 실제 견적 지급은 100, 구매자 잔액은 50입니다. **Local Devnet에서 배포·예치·견적·비공개 정책 승인·판매자 청구·구매자 잔액 청구까지 실제 확정**했고, 거래 7건과 최종 계약 상태를 별도 인덱서 조회로 확인했습니다. 두 테스트 지갑도 별도 프로세스에서 다시 동기화해 seller 100, buyer 50 잔고를 확인했습니다. [증거 JSON](../spikes/veil-intent/docs/evidence/local-devnet-veil-intent.json).

이 실험의 `agent`는 제한된 비밀로 승인 proof를 생성하는 **테스트 역할**입니다. 생성형 AI 모델이 주문을 만들거나 자율적으로 거래를 결정하는 서비스는 아직 연결하지 않았습니다. 제품 가설은 앞으로 그런 agent가 지갑 전체 권한 없이 이 정책 집행 경로를 사용할 수 있다는 것입니다.

이는 정책으로 제한된 **단방향 결제**입니다. 판매 상품/토큰의 인도와 원자적 자산 교환, 다수 견적 경매, 여러 intent의 일일 지출 한도, 브라우저에서 실제 거래하기, Preprod 실행은 아직 구현·검증하지 않았습니다. 시뮬레이터의 잘못된 가격·예산·판매자·수취인·중복 실행 거절은 별도 테스트 결과이며, 실제 체인에서 모든 공격 사례를 재현했다는 뜻은 아닙니다.

## Midnight Implementation

Compact 계약은 공개 고정 escrow 코인을 `receiveShielded`로 받아 보관하고, 구매자의 비공개 최대 단가·총액·수량·nonce를 계약 주소와 salt에 묶은 `intentCommitment`로 저장합니다. 구매자·agent·판매자 비밀 원본과 지급/환불 수취인도 각각 commitment로 고정합니다. 판매자 secret을 가진 견적 제출만 받아 실제 수량·단가·총액을 공개 ledger에 기록합니다. Agent가 원래 private intent와 제한된 secret을 제시하면 계약은 동일 commitment, 수량 일치, 허용된 판매자, 만료 전 상태, `실제 단가 ≤ 비공개 최대 단가`, `실제 총액 ≤ 비공개 최대 총액`을 증명한 뒤 지급 가능 상태로 바꿉니다.

Agent의 승인은 자금 이동이 아닙니다. 판매자가 자신의 고정 수취인으로 100을 claim할 때 escrow 코인이 지출되고, 잔돈 50은 계약에 남아 구매자가 자기 고정 수취인으로 따로 claim합니다. 이 두 단계는 다른 사용자의 지갑에 `sendShielded`로 바로 보낼 경우 수취 알림 ciphertext가 생성되지 않는 현재 SDK 경계를 반영합니다. 승인 후 구매자 취소는 거절되며, 승인 전에만 buyer 비밀로 취소·전액 환불할 수 있습니다. 계약은 7개 공개 증명 회로로 컴파일됐고 시뮬레이터/복구 검사 **14/14**가 통과했습니다.

공개되는 것은 고정 예치액 150, 만료 시각, seller/agent/recipient commitment, 실제 견적 수량·가격·총액, 상태와 거래 시점·proof입니다. **정확한 최대 단가·총액은 실행마다 생성해 보호된 로컬 기록에 두고 공개 증거에는 넣지 않았습니다.** 공개 견적100과 예치150은 상한의 범위를 좁힐 수 있습니다. 판매자 수취인 키는 청구 때 공개 경계에 전달됩니다. 테스트 runner는 세 역할의 seed를 한 프로세스에 보유하고 구매자 genesis 지갑이 모두의 DUST 수수료를 후원했으므로 독립 key-isolated agent 서비스나 완전한 거래 익명성을 입증하지 않습니다. 원시 트랜잭션 전체에 대한 프라이버시 감사도 아직 수행하지 않았습니다.

## Project Deck — Google Slides URL

**미작성/미업로드.** 최종 덱을 Google Slides에 올린 뒤 외부 계정에서 열람 가능한 링크를 입력한다.

## Demo Video — 3분 이내 권장

**미촬영.** 실제 Local Devnet 영수증 7건·seller100/buyer50 readback과 공개/비공개 경계를 시연하는 영상 URL을 입력한다. 웹 화면이 정적 증거 뷰어인 경우 거래 실행 UI처럼 편집하지 않는다.

## Demo URL

https://diveyreadytodive-star.github.io/veil-intent/

GitHub Pages 빌드 `built`, 외부 HTTP 200, HTML·증거 JSON이 로컬 검증 파일과 byte-for-byte 일치하고, 별도 브라우저에서 영수증 7건 로딩과 오류 로그 0을 확인했다. **정적 기록 데모**다. 브라우저의 가격·예산 검사는 로컬 시뮬레이션이며 이 URL에서 실제 지갑 연결이나 새로운 체인 거래는 할 수 없다. 폼 설명에도 같은 제한을 적는다.

## Midnight Academy certificates

사용자 보고상 Explorer/Scholar 인증서를 받았지만 원본 파일 위치와 폼 업로드·가산점 적용은 이 저장소에서 확인하지 않았다. 원본은 Git에 넣지 않고 제출폼에 각각 첨부한다.

## 최종 제출 게이트

- [x] 제출용 기본 브랜치의 공개 repo를 새 폴더에서 clone, 의존성 설치, Compact 컴파일, typecheck, 테스트까지 확인했다. **마지막 제출 커밋 후 한 번 더 확인한다.**
- [ ] public repo topic `midnightntwrk`와 README·폼 설명의 일치를 확인한다.
- [ ] 최종 덱의 Google Slides 링크, 3분 이내 영상, 필요 시 외부 접속 데모 URL을 실제 열어 확인한다.
- [ ] Luma 이름/소속/참가 형태, 대표 연락처, Academy 두 원본 인증서를 확인한다.
- [ ] Tally **최종 제출 영수증**을 확인·보관한다. 초안 작성이나 입력 완료 화면만으로 제출 완료라 하지 않는다.
