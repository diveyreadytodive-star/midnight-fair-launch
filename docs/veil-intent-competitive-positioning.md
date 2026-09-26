# VeilIntent 경쟁작 중복과 피칭 조정

작성: 2026-09-26. 이 문서는 제품의 독창성을 과장하지 않기 위해 **Midnight가 소개한 이전 수상작**을 기준으로 현재 구현을 비교한다. 수상 확률은 정량 추정하지 않는다.

## 심각한 겹침

[Midnight의 2026년 8월 수상작 소개](https://midnight.network/blog/celebrating-seven-winners-from-mlh-x-midnight-july-hack)는 **Latch**를 AI assistant용 비공개 지출 한도·구매 규칙으로 설명한다. [Latch의 Devpost 제출](https://devpost.com/software/latch-23ku8j)은 구매자에게 지갑 전체 키를 주지 않고 좁은 권한으로 결제를 제한한다는 문제, private per-payment/total budget, owner/public observer 분리, Preprod 계약 배포를 내세운다. 따라서 “AI agent에게 지갑 대신 비공개 지출 규칙을 준다”만으로 VeilIntent를 소개하면 **이미 수상한 제품과 핵심 서사가 거의 동일하다.**

같은 [수상작 소개](https://midnight.network/blog/celebrating-seven-winners-from-mlh-x-midnight-july-hack)에는 **NightPool**도 있다. NightPool은 OTC 주문 가격·수량을 commitment로 숨기고 sealed-bid auction, nullifier로 거래를 처리한다. 따라서 “private RFQ/다수 solver 경매”만 미래 차별화로 내세우는 것도 약하다.

| 비교 | 공개 자료로 확인된 초점 | VeilIntent의 확인된 차이 | VeilIntent가 뒤처지는 곳 |
|---|---|---|---|
| Latch | 비공개 agent 지출 정책·카테고리·사용 횟수·취소, Preprod 계약 배포와 정책 시뮬레이터 | **서명된 판매자 견적을 숨긴 구매 상한과 비교한 후, 실제 Local Devnet shielded escrow에서 판매자100·구매자 잔돈50을 각 지갑에 지급**. 배포 포함 7거래·별도 잔고 재조회. Latch 공개 제출에서 확인되는 데모는 배포+정책 시뮬레이터이므로 직접적인 두 지갑 자산 정산 증거는 그 자료에서 확인되지 않는다. 이 문장은 자료 범위에 대한 관찰이지 Latch 전체 코드의 부재 증명이 아니다. | Latch는 더 풍부한 재사용 정책·취소와 Preprod 배포, Lace 연결을 제시한다. VeilIntent는 Local Devnet 한 intent/한 quote이며 운영적 agent 키 격리 미입증. |
| NightPool | 비공개 OTC 주문과 sealed-bid auction, Merkle/nullifier 기반 matching | 공개 판매자 quote와 **비공개 구매자 reservation ceiling**의 검증, 그 결과에 따른 **단방향 실제 지급**. 주문장·입찰·교환 매칭은 하지 않는다. | NightPool은 거래 양쪽의 주문 비밀성과 auction/matching을 다룬다. VeilIntent의 견적·예치액은 공개되고 상품 인도/두 자산 원자 교환도 없다. |
| Safe allowance | [공식 Safe 문서](https://docs.safe.global/home/ai-agent-quickstarts/agent-with-spending-limit)는 agent에게 token별 지출 한도를 위임한다 | VeilIntent는 온체인 공개자에게 구매자의 **정확한 per-intent 최대 단가·총액을 직접 공개하지 않고** quote 통과를 증명한다. | Safe는 실제 DAO treasury 운영과 반복 한도에 더 가깝다. VeilIntent는 가치 없는 테스트 결제 하나다. |

## 이제 앞에 내세울 문제

**“Treasury buyer는 seller의 실제 견적을 받아도 자신의 최대 허용 가격을 공개할 이유가 없다. 하지만 견적이 승인된 조건 안이고 실제 대금이 그 판매자에게 갔다는 사실은 검증 가능해야 한다.”**

VeilIntent의 초점은 **private authorization 자체**가 아니라 **private authorization에서 real shielded payout까지의 연결**이다. 한 구매자·한 허가 판매자·한 공개 quote에서만 검증됐다. 홈페이지/덱/폼의 첫 문장을 이 흐름으로 맞추고, agent 권한은 이를 가능하게 하는 한 구성요소로 뒤에 설명한다.

### 한 문장 피칭 후보

> A seller can publish a quote; Midnight proves it fits the buyer's hidden ceiling and settles the payment to that seller, without publishing the ceiling.

### 20초 데모 도입

> “판매자가 공개 견적 100을 냅니다. 구매자의 최대 허용액은 공개하지 않습니다. Compact가 견적이 비공개 상한 안인지 증명하고, 계약은 판매자에게 100을 지급합니다. 남은 50은 구매자가 회수합니다. 이 일곱 단계가 Local Devnet에서 실제 확정됐습니다.”

## 여전히 약한 지점

1. **상품·토큰 인도 없음:** 양자 간 교환 완료가 아니라 정책 제한 결제다. “RFQ DEX/atomic settlement”라고 부르지 않는다.
2. **거래 비밀성 제한:** 실제 quote100, 예치150, 타이밍·claim recipient 공개 경계가 있다. 숨긴 것은 정확한 상한/정책 원문이며 100–150 범위는 드러난다.
3. **Agent 실운영 없음:** 생성형 모델 연동이 없고 테스트 runner는 모든 seed를 한 프로세스에 보유한다. Compact ABI가 buyer seed 없이 agent 승인 proof를 요구한다는 것과 운영 서비스 키 격리는 다르다.
4. **상용성 없음:** Local Devnet의 가치 없는 토큰, 한 intent/한 quote, 재사용 mandate·반복 지출 한도·보험/분쟁 해결 없음. 고객 수요/PMF 증거도 아직 없다.

사용자가 피칭 방향을 확정하기 전에도 구현과 증거는 보존한다. 이 문서는 **주제 재선정 요구가 아니라 현재 증거에 맞는 메시지 수정안**이다.
