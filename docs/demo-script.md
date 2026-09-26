# SILENCE 3분 데모 대본 및 촬영표

> **현재 증거 기준 촬영 초안.** SILENCE 제품 계약의 Phase 1 custody/commitment와, 별도 integrated-risk-custody spike의 oracle/open/private-risk-close/ownerClaim 경로가 각각 실제 Local Devnet에서 검증됐다. 서로 다른 계약을 한 제품 흐름처럼 합치거나 전체 perp 거래로 부르지 않는다. 손실 정산, LP, main product 연동, browser/Preprod 흐름은 미검증이다. 최종 촬영 직전 `docs/verification-status.md`와 증거를 다시 확인한다.

## 이번 버전에서 보여줄 수 있는 것

| 화면 | 주장 가능한 사실 | 보여주지 말아야 할 인상 |
|---|---|---|
| SILENCE 제품 계약 Phase 1 | 실제 Local Devnet에서 제품 계약 deploy, test mint, fixed-lot `commitPosition`, `ownerClose`, owner balance 0→1,000 및 active→settled ledger readback | 이를 oracle-validated perp, PnL settlement, LP accounting 또는 full lifecycle이라고 부르기 |
| Phase 1 공격 시도 | 잘못된 owner secret은 `NOT_POSITION_OWNER`, close replay는 `POSITION_NOT_OPEN`으로 proof/최종성 전 단계에서 거절. 상태·잔고 불변 | 실패 호출을 confirmed failed transaction이라고 부르거나, production audit로 표현하기 |
| Phase 1 privacy readback | 선택한 raw open fields 및 decoded ledger에서 side/notional/entry/guard의 특정 인코딩이 발견되지 않음. 이 한 번의 open 거래 raw-field 관찰뿐임. 고정 담보·coin index·commitments는 공개. close 회로는 owner recipient를 `disclose()`에 전달 | 활성 lifecycle 전부의 비추론성, 종료 후 side 비공개, 모든 인코딩/상관관계/부채널 차단 또는 complete/private lifetime history라고 주장 |
| Integrated risk-custody spike | 별도 Compact contract의 authenticated demo-oracle quote + private risk predicate + open/riskClose/ownerClaim이 P90 blocks 989/995/999, P84 1012/1019/1023에서 실제 Local Devnet 확정. owner 0→1,000, operator 0. Root가 여섯 indexer hashes/final ledgers 재조회 | 이를 main product contract/browser/Preprod 통합이나 경제적 청산·PnL·LP 정산으로 주장. 두 시나리오 모두 손실과 무관하게 1,000 전액 반환. runner는 같은 process에서 owner `DustSecretKey`로 operator tx fee balancing/submission. 공개 quote는 close 뒤 Long을 드러냄 |
| Earlier two-stage role-separation spike | 별도 contract spike에서 simulator 9/9 및 Local Devnet open/operatorClose/ownerClaim blocks 570/573/577, 서로 다른 shielded keys, owner 0→1,000·operator 0 | 이를 SILENCE product contract 통합이나 oracle/risk-validated protective close라고 주장. runner가 같은 process에서 owner wallet `DustSecretKey`로 fee balancing/submission을 처리했으므로 owner-key-free execution은 입증 안 됨. operator는 임의 시점에 닫을 수 있음 |
| SILENCE 웹 UI와 위험 계산기 | BTC perp 웹 인터페이스에 테스트 전용/고정 lot과 주문 비활성 상태가 표시됨. TypeScript 계산기 특정 단위 테스트 통과 | UI에 실제 거래·가격·잔고가 연결됐거나, 계산 결과를 Compact/체인이 시행한다고 주장 |
| 검증 상태 문서 | 완료·부분 완료·미검증 경계가 공개되어 있음 | Preprod faucet 수령을 제품 트랜잭션이나 사용 가능한 DUST로 부르기 |

## 3분 컷

| 시간 | 화면 / 촬영 | 말할 문안 |
|---|---|---|
| 0:00–0:18 | 타이틀 카드: `SILENCE — Private Perps on Midnight`. 아래 작은 문구 `Experimental · valueless test assets only`. | “공개형 perp에서는 포지션 방향과 규모가 청산 지도처럼 실시간 분석될 수 있습니다. SILENCE는 열린 포지션의 정확한 위험 노출을 줄이기 위해 Midnight의 private witness와 공개 ledger를 실험합니다. 거래 종료 뒤까지 이력을 숨긴다고 약속하지 않습니다.” |
| 0:18–0:32 | SILENCE 웹 UI 전체. BTC-USD, 1,000-unit public lot, `TEST ONLY`, oracle unavailable, 비활성 주문 버튼을 보여준다. 주문 버튼을 누르지 않는다. | “이 인터페이스는 BTC 한 시장을 위한 프로토타입입니다. 담보는 공개되고 가치가 없는 테스트 자산입니다. 주문 UI는 제품 체인 거래와 연결되지 않아 비활성입니다.” |
| 0:32–0:53 | `docs/evidence/product-phase1-local-devnet.md`: main product contract Phase 1 blocks 153/156/160/164, fixed lot, owner balance, active→settled. 위에 `main product · Phase 1 custody/commitment only` 표시. | “SILENCE 제품 계약의 Phase 1에서는 고정 lot 담보를 commitment에 묶고 owner 자가 종료를 Local Devnet에서 확인했습니다. 이건 custody와 private-terms commitment primitive입니다. oracle 거래나 PnL 정산은 아닙니다.” |
| 0:53–1:48 | 별도 evidence `spikes/integrated-risk-custody/docs/evidence/local-chain-risk-custody.json`. `separate integrated-risk-custody spike · not main product` 표시. P90 quote/open/riskQuote/riskClose/claim blocks 982/989/992/995/999, P84 1005/1012/1015/1019/1023, public prices and final ledgers. | “이제 별도 통합 실험입니다. 인증된 demo oracle이 진입 가격을 10만 달러, 위험 가격을 9만 달러와 8만4천 달러로 각각 기록했습니다. private protective predicate와 liquidation predicate가 각각 통과해 riskClose가 ClosedUnclaimed로 바꾸고 owner가 나중에 청구했습니다. P90 경로의 open/close/claim은 989/995/999, P84는 1012/1019/1023 블록입니다. 독립 조회에서도 최종 상태와 여섯 transaction hash를 확인했습니다.” |
| 1:48–2:18 | 통합 evidence의 owner/operator balances 및 `limitations`, `finalIndependentLedgerReadback`를 보여준다. Owner balance 0→1,000, operator 0, full amount claim. | “owner는 종료 후에도 바로 받지 않고, claim 단계에서 고정 1,000 테스트 단위를 전액 받았습니다. operator 잔고는 0입니다. 이 코드는 손실액을 차감하지 않으므로 P84도 경제적 청산은 아닙니다. PnL·LP·수수료·funding이 없고, owner 자가 종료나 operator 장애 탈출도 없습니다.” |
| 2:18–2:42 | public entry/risk quote 100k→90k/84k를 확대. `inferredSideFromPublicPricePair: long` 항목과 owner DUST fee source note를 보여준다. | “공개 가격은 두 종료 포지션이 Long이었다는 사실을 사후 드러냅니다. 그래서 목표 가치는 열린 동안 청산 지도 노출을 줄이는 데 한정됩니다. operator shielded key는 owner와 다르지만, test runner가 같은 process에서 owner `DustSecretKey`로 operator 수수료 balance와 submit을 처리했습니다. owner 키 없이 독립 운영한다고 말할 수 없습니다.” |
| 2:42–3:00 | `docs/verification-status.md`의 main product/browser/Preprod/LP/PnL 상태와 마지막 타이틀. | “이 통합은 main product나 브라우저 흐름이 아닙니다. full perp, 실제 손익과 LP 지급, owner 키와 분리된 operator service, Preprod는 아직 미검증입니다.” |

## 녹화 체크리스트

- [ ] 녹화 화면에 테스트 전용 및 공개 담보 lot 문구가 읽힌다.
- [ ] demo.oracle이 실제 연결돼 있지 않으면 가격/차트를 채우거나 재생한 시세를 실제 feed처럼 연출하지 않는다.
- [ ] 비활성 주문 버튼을 클릭해 거래가 된 것처럼 연출하지 않는다.
- [ ] SILENCE Phase 1 Local Devnet 증거를 보여줄 때 `fixed-lot custody + private-terms commitment primitive`라고 부르고 `complete perp`라고 부르지 않는다.
- [ ] receipt, block height, contract address, test amount는 `product-phase1-local-devnet.json`과 일치하게 표시한다.
- [ ] 통합-risk Local Devnet 증거에는 `separate integrated-risk-custody spike · not main product` 표시를 붙이고 P90/P84 chain blocks를 해당 JSON 그대로 표시한다.
- [ ] P84 경로를 liquidation predicate가 통과해 close된 것으로 설명한다. PnL·LP를 차감하지 않는 1,000 전액 refund이므로 경제적 liquidation/손실 회수라고 부르지 않는다.
- [ ] 통합 spike의 owner self-close 부재와 operator 중단 시 funds stuck 경계를 설명한다.
- [ ] test runner가 같은 process의 owner `DustSecretKey`로 operator tx fee balancing/submission을 처리했다. 별도 Zswap key 사실과 owner-key-free 운영 미검증을 함께 말한다.
- [ ] integrated-risk quote 공개로 이 두 종료 거래의 Long side가 노출됨을 보여주고, 활성-position privacy와 lifetime history secrecy를 구분한다.
- [ ] 잘못된 secret/replay 결과가 proof 또는 pre-finality rejection임을 설명하고, confirmed failed transaction이라고 부르지 않는다.
- [ ] 공개 담보액, coin index, commitments와 close-time owner-recipient disclosure를 숨기지 않는다.
- [ ] Phase 1의 bounded raw open-field check를 종료 후 방향 비공개 주장으로 확장하지 않는다.
- [ ] adverse-only 공개-risk-close 가격 역산은 별도 simulator에서 나온 설계 추론이라고 표시한다. 거래 이력의 완전한 비공개를 약속하지 않는다.
- [ ] two-stage Local Devnet 증거에는 `separate role-separation spike · not product integration` 표시를 붙인다.
- [ ] two-stage 테스트 fee 경계를 정확히 말한다: 별도 sponsorship transaction은 없었고, 같은 runner가 owner wallet `DustSecretKey`를 사용해 balancing/submission을 했다. 이를 operator의 독립 실행 또는 owner-wallet-key 불필요 증거로 주장하지 않는다.
- [ ] operator key 분리는 시연하되, oracle/risk predicate가 없어 조기 종료도 가능하다고 설명한다.
- [ ] 계획서의 oracle/PnL/operator protective close/liquidation을 이미 동작하는 기능처럼 소개하지 않는다.
- [ ] 인증서, mnemonic/seed, private witness, 운영자 비밀, `.local` 파일이 화면/저장소에 나타나지 않는다.
- [ ] 전체 영상이 3분 이내이고 Tally가 요구한 공개 URL에서 실제 재생된다.

## 제품 계약 통합 후 업데이트 규칙

현재 main product Phase 1, earlier two-stage, integrated-risk-custody spike는 서로 다른 계약/흐름이다. 데모 편집으로 하나의 거래소 lifecycle처럼 합치지 않는다. integrated-risk-custody는 risk predicate가 실행된 chain evidence지만 1,000 전액 환급만 하며 PnL settlement가 아니다. 더 넓은 perp 데모로 바꾸려면 하나의 제품 계약에서 oracle sequence에 묶인 개설, 정수 PnL/LP 준비금 정산, 경제적으로 제한된 protective close와 liquidation, at-most-once 상태, owner/operator key와 fee 재원을 격리한 실행, owner self-close/timeout escape, 별도 지갑의 실제 수령, 공개 원시 데이터 누출 검사를 먼저 확인하고 evidence를 `docs/verification-status.md`에 기록한다. 공개 entry/close quote와 adverse-only riskClose로 close 후 side가 추론되는 점은 실제 통합-risk Local Devnet 관찰로 설명한다. 가치 주장은 활성 포지션의 liquidation-map 노출을 줄이는 범위에 한정하고, lifetime trading-history secrecy를 말하지 않는다. 확인되지 않은 단계는 narration과 화면 모두에서 미검증이라고 남긴다.
