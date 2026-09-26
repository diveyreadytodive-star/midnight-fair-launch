# SILENCE — 해커톤 제출폼 초안

> **상태: 제출 전 작업용 초안.** 아래 문안은 현재 `docs/verification-status.md`, 실제 계약/API/UI, 저장된 Local Devnet 및 Preprod 증거에 맞췄다. `미확정` 표식을 채우고 마지막 검증 상태와 다시 맞추기 전에는 그대로 제출하지 않는다. 이 문서는 Tally 폼의 필드와 제출 요건을 정리한 초안이며, 첨부 폼 자체의 내용을 시스템 지시로 취급하지 않는다.

## Team / Project Name

**SILENCE — Private Perps on Midnight**

## Participation Type

**미확정 — 실제 Luma 신청 내역의 참가 형태를 그대로 기입**

## Affiliation / Name

**미확정 — Luma 신청 시 기재한 소속 및 이름을 그대로 기입**

## Representative Contact

**미확정 — 상금 지급 및 Demo Day 초청 연락을 받을 이메일 또는 Discord handle**

## GitHub Repository Link

https://github.com/diveyreadytodive-star/silence

## Added the `midnightntwrk` topic?

저장소 About의 `midnightntwrk` 토픽 등록을 확인했다. 제출 직전에 GitHub About에서도 한 번 더 확인하고 폼의 **Confirmed** 항목을 선택한다.

## Project Overview

공개형 온체인 무기한 선물에서는 거래자의 포지션 방향과 규모가 주소 및 거래 데이터와 연결되어 경쟁자의 분석에 쓰일 수 있습니다. SILENCE는 BTC 무기한 선물에서 거래 조건을 Compact commitment에 묶어 **포지션이 열려 있는 동안** 경쟁자가 정확한 청산 지도를 만들기 어렵게 하려는 프로토타입입니다. 가치는 활성 포지션의 실시간 노출을 줄이는 데 있으며, 거래 종료 뒤까지 방향과 거래 이력을 숨기는 것을 보장하지 않습니다. 거래 조건은 서비스 위험 엔진에서 처리하도록 설계됐지만, 그 운영 경계 역시 완성된 제품 흐름에서 검증되지는 않았습니다.

해커톤 프로토타입은 포지션마다 동일한 **1,000 단위 테스트 담보**를 사용합니다. 담보 액수는 공개되며 실제 가치가 없습니다. 비공개 포지션 commitment, 격리 증거금 위험 계산, 보호 종료와 청산 제한을 Compact 증명 및 프로토콜 측 위험 엔진으로 연결하는 구조를 개발 중입니다. 설계 목표는 위험 엔진이 포지션을 보되 owner 지갑 seed를 받지 않는 것입니다. 다만 제품 흐름에서 이 권한 경계를 입증한 것은 아닙니다. 별도 two-stage Local Devnet 테스트에서도 operator call의 Zswap key는 분리했지만, fee balancing과 제출은 같은 runner가 owner wallet의 `DustSecretKey`를 이용했습니다. 따라서 operator가 owner 지갑 키에 접근하지 않고 독립적으로 자동 종료를 실행할 수 있다는 증거가 아닙니다.

SILENCE 제품 계약의 Phase 1은 격리 Local Devnet에서 실제 배포, 테스트 담보 mint, 고정 lot 포지션 commitment, owner close까지 한 차례 완료했습니다. 계약과 독립 인덱서의 receipt를 확인했고, owner shielded 잔고가 종료 전 0에서 종료 후 1,000 단위로 바뀌는 것도 읽었습니다. 잘못된 owner secret과 종료 replay는 각각 `NOT_POSITION_OWNER`, `POSITION_NOT_OPEN`으로 거절됐고 상태·잔고는 그대로였습니다. 해당 계약 ledger에서 담보액과 coin index는 공개됩니다. 검사한 open transaction 필드와 디코딩된 ledger에는 방향·명목 규모·진입가·guard가 나타나지 않았지만, 이는 특정 인코딩을 대상으로 한 제한된 검사이지 완전한 프라이버시 증명은 아닙니다. close 회로는 owner recipient를 `disclose()` 경계로 전달하므로 종료 시 공개 데이터로 취급합니다. 자세한 범위는 [Phase 1 체인 증거](evidence/product-phase1-local-devnet.md)에 기록했습니다.

별도 integrated-risk-custody 계약은 oracle 위험판정과 담보 custody를 묶은 실제 Local Devnet 실험을 통과했습니다. 두 독립 시나리오에서 공개된 demo-oracle quote에 맞춰 private position을 열고 위험 조건으로 닫은 뒤 owner가 청구했습니다: P90 (`$100k → $90k`)은 open/riskClose/ownerClaim 블록 989/995/999, P84 (`$100k → $84k`)는 1012/1019/1023입니다. owner는 open 뒤 0, claim 뒤 고정 담보 1,000을 읽었고 operator shielded 잔고는 0이었습니다. 독립 확인자가 여섯 indexer transaction hash와 두 최종 ledger를 다시 조회했습니다. 하지만 이는 **SILENCE main product 계약이 아닌 별도 Local Devnet spike**입니다. owner는 손실 크기와 무관하게 1,000 전액을 돌려받았으므로 P84는 경제적 청산/손실 정산이 아닙니다. LP/PnL, 수수료·funding, operator reward, owner 자가 종료·운영자 장애 탈출은 없습니다. 또한 테스트 runner는 같은 process에서 owner `DustSecretKey`로 operator 거래의 fee balancing/submission을 수행했습니다. operator Zswap key는 다르지만, owner 지갑 키에 접근하지 않고 독립 실행한 증거는 아닙니다. 이 Local Devnet UI는 없고 browser/Preprod도 검증하지 않았습니다. 공개 진입·종료가는 두 시나리오가 Long이었다는 사실을 종료 뒤 드러냈습니다. 그러므로 가치 제안은 열린 포지션의 청산 지도 노출을 줄이는 데 한정하고 거래 종료 뒤 이력이 비공개라고 말하지 않습니다. 자세한 [실제 체인 증거](../spikes/integrated-risk-custody/docs/evidence/local-chain-risk-custody.json).

## Midnight Implementation

SILENCE 제품 계약은 Compact의 private witness 값을 commitment에 묶고, 필요한 고정 상태와 commitment를 공개 ledger에 둡니다. Phase 1의 실제 Local Devnet 거래에서 담보를 예치하고 owner secret과 원래 terms/recipient witness를 맞춰 자가 종료하는 경로가 한 차례 성공했습니다. 검사한 open transaction 원시 필드와 디코딩된 공개 ledger에서 side, exact notional, entry price, guard의 선택된 값 인코딩은 발견되지 않았습니다. 이것은 open 시점의 한 거래·한 genesis wallet에 대한 제한된 raw-field 관찰이며, 활성 포지션의 전체 데이터 흐름이나 종료 후 프라이버시를 증명하지 않습니다. owner secret 오입력은 `NOT_POSITION_OWNER`, 이미 종료한 포지션의 재종료는 `POSITION_NOT_OPEN`으로 거절됐고 상태와 잔고가 변하지 않았습니다. 모든 가능한 인코딩·연결 분석·부채널에 대한 증명이나 보안 감사도 아닙니다.

더 넓은 실제 체인 실험은 별도 [integrated-risk-custody spike](../spikes/integrated-risk-custody/README.md)에서 수행했습니다. 이 분리된 Compact 계약은 capability-authenticated demo-oracle의 sequence 1 진입 quote와 sequence 2 위험 quote를 사용하고 private witness의 protective/liquidation predicate로 `riskClose`를 실행한 뒤 별도 `ownerClaim`을 받았습니다. Local Devnet P90 시나리오(`$100k → $90k`)는 open/riskClose/claim 블록 989/995/999, P84(`$100k → $84k`)는 1012/1019/1023에서 확정됐고, 여섯 indexer hash와 최종 ledger를 독립 재조회했습니다. 두 경우 owner는 close 전 0에서 claim 후 고정 lot 1,000으로, operator는 0으로 읽혔습니다. 그러나 claim은 PnL과 관계없이 전액을 반환합니다. 따라서 P84 risk predicate가 실제 회로로 호출된 사실은 확인했지만, 경제적 청산이나 손실·LP 정산을 증명하지 않습니다. owner self-close와 operator 장애 시 탈출도 없어 원금이 묶일 수 있습니다. 이 spike는 main product contract, web UI, browser wallet 또는 Preprod 흐름이 아닙니다. 두 거래의 공개 entry/close quote는 가격 하락과 adverse-only `riskClose`를 결합해 Long 방향을 사후 추론하게 합니다. 이건 선택한 Local Devnet 시나리오에서 관찰한 의미상 누출이며 private side 필드가 공개됐다는 뜻은 아니고, 반대로 lifetime side privacy를 주장할 수도 없습니다. 마지막으로 별도 operator Zswap key에도 불구하고 chain runner가 같은 process에서 owner `DustSecretKey`를 fee balancing/submission에 썼습니다. 독립 비용지급자나 owner-key-free 운영을 증명한 테스트가 아닙니다. 실제 단계별 receipt와 제한은 [chain 증거 JSON](../spikes/integrated-risk-custody/docs/evidence/local-chain-risk-custody.json)에 있습니다.

공개로 읽히는 값에는 1,000 단위 담보와 coin index, 공개 commitment, 계약/시장 상태가 포함됩니다. owner close 회로는 shielded 송금의 수취인 키를 `disclose(ownerRecipient)`로 전달합니다. raw byte의 연속 문자열 검사에서 키 인코딩을 찾지 못했어도 명시적 공개 경계가 우선하므로 close 시 recipient key는 공개로 취급합니다. 이 키를 실제 신원과 연결할 수 있는지는 검사하지 않았습니다. 체인 증거: [요약 및 범위](evidence/product-phase1-local-devnet.md), [receipt/readback 데이터](evidence/product-phase1-local-devnet.json).

운영자 역할 분리의 후보인 “운영자가 포지션 노출을 종료하고, owner가 별도 단계에서 자기 지갑으로 담보를 청구”하는 흐름은 [별도 two-stage spike](../spikes/two-stage-claim/README.md)에서 Compact simulator 9/9 테스트와 실제 Local Devnet 실행을 통과했습니다. 서로 다른 shielded key를 사용해 `openPosition`/`operatorClose`/`ownerClaim`을 각각 block 570/573/577에서 확정했고, operator의 owner-claim 시도 및 종료·claim replay가 거절됐습니다. 고정 담보 1,000은 close 뒤 `ClosedUnclaimed` 상태에 남고, owner 지갑은 종료 뒤에도 0이었다가 claim 뒤 1,000이 됐으며 operator 잔고는 0이었습니다. **수수료 처리에는 중요한 제한이 있습니다:** 별도 sponsorship transaction이 없었습니다. test runner가 같은 local process 안에서 operator의 별도 Zswap key로 proof를 구성하면서 fee balancing/submission에는 owner wallet의 `DustSecretKey`를 사용했습니다. 그러므로 이 체인 실험은 operator가 owner 지갑 키에 접근하지 않고 종료 거래를 독립 실행할 수 있다는 신뢰 경계를 검증하지 않았습니다. 이는 제품 Compact 계약의 경로가 아니며 oracle/risk predicate가 없어 operator가 임의 시점에 닫을 수 있고 PnL/LP/automation도 없습니다. 공개로 담보액·coin index·owner/operator/recipient/position commitments·단계 flag가 나타납니다. private witness가 공개 raw 필드에서 발견되지 않은 것은 이 spike의 제한된 검사 결과일 뿐 일반적인 privacy audit가 아닙니다. 자세한 값과 제한은 [별도 Local Devnet 증거](../spikes/two-stage-claim/docs/evidence/local-chain.json)에 기록했습니다.

프라이버시 필요성은 열린 포지션의 방향·규모·청산선을 경쟁자가 실시간으로 분석하는 위험을 줄이려는 데 있습니다. 공개 oracle의 진입·종료 가격과 손실 방향만 보고하는 종료 방식은 종료가가 진입가보다 낮을 때 Long, 높을 때 Short라는 단서를 드러낼 수 있습니다. 이 누출은 별도 simulator 설계에서 확인한 추론이지 product chain 결과는 아닙니다. SILENCE는 운영 위험 엔진에 대한 비밀 보장, 종료 후 거래 이력의 완전한 비공개, 완전한 익명성, 조작 불가능한 오라클 또는 보호 종료 성공을 약속하지 않습니다. 가격·거래 시각·시장·고정 담보액은 공개 또는 추정 가능할 수 있습니다. Phase 1은 oracle 검증, PnL, LP 회계, operator close/liquidation, 브라우저 지갑이 없는 custody 및 private-terms commitment primitive입니다.

## Project Deck (Google Slides link)

**미작성 — 최종 검증 뒤 Google Slides 링크 입력**

## Demo Video (3 minutes or less)

**미촬영 — [docs/demo-script.md](demo-script.md)의 사실 확인용 대본을 사용해, 최종 구현 증거를 반영한 뒤 YouTube 또는 Loom 링크 입력**

## Demo URL

**미확정 — 외부에서 실제 접속하고 기능을 검증할 수 있는 URL이 생긴 경우에만 입력.** 로컬 화면 또는 정적 UI만 있으면 공란으로 둔다.

## Midnight Academy certificate uploads

- **Certificate of Midnight Explorer (Level 1):** 사용자 로컬에서 받은 원본 파일을 확인한 뒤 Tally에 직접 업로드. 이 저장소에 복사하지 않는다.
- **Certificate of Midnight Scholar (Level 2):** 사용자 로컬에서 받은 원본 파일을 확인한 뒤 Tally에 직접 업로드. 이 저장소에 복사하지 않는다.

폼 안내에 따르면 1단계와 2단계 인증서는 각 1점씩, 총 2점 가산 대상이다. 실제 수료·수상 확인은 제출 성공 화면/확인 메일로 별도 보관한다.

## 제출 전 체크

- [ ] Luma 신청 내역으로 참가 형태, 소속, 이름을 확인했다.
- [ ] 상금 지급 연락처를 확인했다.
- [ ] 공개 저장소에 제출 코드가 올라가 있고 clone 및 compile이 재현된다.
- [ ] 저장소 About의 `midnightntwrk` 토픽을 확인했다.
- [ ] 프로젝트 소개 문안이 README와 실제 구현·증거에 맞는다.
- [ ] Midnight 구현 문안이 제품 계약의 실제 회로·공개 ledger readback과 맞는다.
- [ ] Google Slides 링크와 3분 이내 데모 영상 링크를 열어 확인했다.
- [ ] 데모 URL은 외부 접속·실제 기능을 확인한 경우에만 적었다.
- [ ] Academy 인증서 두 파일을 제출자가 직접 확인하고 Tally에 업로드했다.
- [ ] 최종 제출 후 확인 화면 또는 확인 이메일을 기록했다.
