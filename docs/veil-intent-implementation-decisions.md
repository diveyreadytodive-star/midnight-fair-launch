# VeilIntent MVP 구현 결정

작성: 2026-09-26. 원문 제안: 사용자 제공 `VeilIntent - SILENCE 재사용 기반 제품 설계와 개발 방향`. 이 문서는 제안의 범위를 실제 구현·검증 가능한 계약으로 좁히고, 자금과 신뢰 경계의 모순을 해결한다. 기존 SILENCE 커밋 `79a439a`는 보존한다.

진행 상태: `codex/veil-intent`의 **7회로 Compact 계약**은 컴파일·strict TypeScript·14/14 시뮬레이터/복구 검사를 통과했다. **실제 Local Devnet**에서 배포, 공개 테스트 토큰 150 발행, 구매자 intent 예치, 판매자 quote, agent의 비공개 정책 승인, 판매자 자기 지갑 지급 100, 구매자 자기 지갑 잔액 50을 끝까지 확정했다. [공개 가능한 영수증 JSON](../spikes/veil-intent/docs/evidence/local-devnet-veil-intent.json)의 배포 포함 거래 7건을 별도 인덱서 조회로 대조하고, 보호된 테스트 지갑 두 개를 별도 프로세스로 동기화해 잔고 100/50을 다시 확인했다. **브라우저 주문, Preprod, 독립 agent 서비스는 아직 검증하지 않았다.**

## 제품 문장

**VeilIntent는 판매자의 공개 견적을 구매자의 숨긴 최대 허용 가격·총액과 Compact로 대조하고, 허용된 경우 계약에 잠긴 테스트 자금을 그 판매자에게 실제 지급하는 결제 원형이다.** 제한된 agent 권한은 이 검증을 실행하는 한 방법이다. 이번 MVP는 구매한 토큰이나 상품의 인도까지 보장하는 원자적 교환소가 아니다. 이전 Midnight 수상작과의 겹침·차이는 [별도 비교](veil-intent-competitive-positioning.md)에 기록했다.

[Midnight의 agentic intent 글](https://midnight.network/blog/midnight-city-simulation-live)은 실행 전 의도와 조건이 전략적 정보가 될 수 있다는 문제를 직접 다룬다. 해커톤 피칭의 연결점은 이 공식 메시지와 **조건을 숨긴 채 지출 규칙을 증명하는 실제 체인 거래**다. 다만 `VeilIntent`라는 이름은 [기존 PyPI 패키지 설명](https://pypi.org/project/veil-privacy/)에 이미 등장하므로 현재는 작업명으로 취급하고 제출 전 명칭 충돌을 확인한다.

## 역할과 비밀의 소유자

| 역할 | 아는 것 | 할 수 있는 것 | 하면 안 되는 것 |
|---|---|---|---|
| 구매자/treasury | 정책 원문, escrow 지갑, 환불 수취인 | 고정 테스트 lot 예치, 정책·agent 권한 고정, 만료 시 환불 | 지갑 seed를 agent/solver에게 넘기지 않음 |
| Agent/신뢰된 로컬 prover | 거래 집행에 필요한 정책 witness와 제한된 `agentSecret` | seller quote가 정책을 만족함을 증명하고 실행 상태로 전환 | 구매자 지갑 전체를 임의로 출금하거나 수취인 변경 불가 |
| Seller/solver | 자기 quote와 청구 비밀, 자기 수취인 | 공개 quote 등록, 허용된 지급을 자기 수취인으로 청구 | 구매자의 최대 가격·전체 예산 witness 열람 불가 |
| 공개 관찰자 | 고정 escrow lot, quote 실제액, commitment, 상태·시각, 지급 거래 | 성공·거절 상태 및 온체인 proof 확인 | 정책 상한 원문 열람 불가 |

**핵심 기술 결정:** solver가 구매자의 정책을 모른다면 solver 단독으로 비공개 정책을 넣은 proof를 만들 수 없다. quote 제출은 seller가 하되 `approveQuote` proof는 정책 witness를 가진 agent/구매자 측 로컬 prover가 만든다. 이 prover가 운영 서비스라면 정책 원문을 볼 수 있으므로, “운영자도 모른다”는 주장은 금지한다. 목표 제품에서 AI 모델은 거래 **제안 생성기**로 제한하고, 비밀 정책·권한을 가진 로컬 집행기가 최종 증명을 만든다.

실제 9/26 체인 실험에는 생성형 AI 모델이나 자율적으로 주문을 고르는 서비스가 연결되지 않았다. `agent`는 별도 shielded 키와 제한 secret으로 Compact 승인 회로를 호출하는 **테스트 역할**이다. 따라서 “AI agent가 실제 구매를 했다”가 아니라 “AI agent가 사용할 수 있는 제한 지출 증명 경로를 시험했다”고 설명한다. 같은 테스트 프로세스가 buyer·seller·solver의 seed를 모두 보유하고 buyer가 DUST 수수료를 후원했으므로 운영상 키 격리를 입증하지 않았다.

## 자금 모델과 공개 범위

- 단일 허가 판매자, 단일 intent, 단일 가치 없는 Local Devnet 결제 토큰. **고정 공개 escrow lot 150**으로 정한다. 예시 비공개 최대 총액 102, seller 실제 quote 100. 예치 lot을 비공개 최대액과 같게 만들면 ledger에서 정책 상한이 바로 추론되므로 사용하지 않는다.
- `submitQuote`는 seller가 제시한 실제 총액과 단가를 공개 상태에 기록한다. `executeQuote`는 비공개 최대 단가·총액, seller 허용 조건, agent 권한, 마감, nonce/단일 사용을 증명한다. 실제 quote 금액을 숨긴다고 주장하지 않는다.
- 집행 후 계약의 escrow에서 seller에게 실제액 100을 지급하고, buyer에게 나머지 50을 환불해야 한다. [Compact의 `sendShielded` 공식 문서](https://docs.midnight.network/compact/standard-library/exports#sendshielded)는 현재 사용자 외의 수취인에게 바로 보낼 때 수취 알림용 coin ciphertext가 생성되지 않는다고 명시한다. 따라서 서로 다른 지갑의 자동 발견을 가정하지 않고 기존 SILENCE의 `ClosedUnclaimed`와 **seller 자기 지갑 후속 claim** 패턴을 재사용한다. 그다음 buyer가 잔돈을 별도 청구한다. 각 지급의 receipt·ledger·지갑 잔고를 별도로 확인한다.
- seller가 상품·토큰을 전달했는지는 계약이 검증하지 않는다. 따라서 원문에서 사용한 “RFQ 정산”은 MVP에서 **quote 조건을 만족한 결제**라는 의미로 한정한다. 진짜 자산 교환은 seller-side escrow와 원자적 두 자산 청구를 추가한 후속 단계다.
- 여러 intent에 걸친 `maxDailySpend`는 이번 계약에서 강제하지 않는다. 단일 intent/한 번 지출만 증명한다. 별도 계약마다 동일 mandate를 만들면 일일 지출 합계를 넘길 수 있으므로 이를 제품 기능으로 쓰지 않는다.

## 계약 상태와 회로 목표

이번 실험은 **한 intent 안에 private spending policy를 묶는다**. 별도 재사용 가능한 mandate 등록/갱신 계약은 범위 밖이다. 공개 상태 목표: `intentCommitment`, 고정 escrow 코인, buyer/agent/seller capability commitment, seller/buyer recipient commitment, 공개 quote 금액·수량, expiry, `Open → Quoted → Approved → Settled` 또는 `Cancelled`, 청구 여부. 비밀 witness: 정책 최대 단가/총액, 허용 seller, agent secret, intent salt, recipient salt. 도메인·계약 주소·nonce를 commitment에 묶어 다른 계약/의도 재사용을 막는다.

배포 한도에 걸린 SILENCE 15회로 사례 때문에 **공개 proof 회로는 처음에 약 5~7개**로 유지한다. 목표 경로는 `mintTestCoin`, `createIntent`, `submitQuote`, `executeQuote`, `sellerClaim`, `buyerClaimRemainder`, `cancelExpiredIntent`이다. 순수 helper는 exported proof 회로 수에 포함되지 않게 작성한다. 실제 회로 수와 배포 거래 한도는 컴파일·실제 Local Devnet 배포로 확인하며, 숫자만 줄였다고 배포 가능하다고 주장하지 않는다.

환불 가능성은 필수다. 거절 quote나 기한 만료 때문에 buyer 자금이 영구히 잠기지 않아야 한다. 실행이 승인된 뒤 seller가 청구하지 않아도 buyer가 seller 몫을 임의 환불받게 하면 판매자 권리가 깨진다. 이 liveness는 MVP 한계로 표시하고, seller claim을 실제 데모에서 마친다.

첫 계약은 **intent당 판매자 quote 1개만** 받는다. 판매자 quote가 비공개 정책을 넘으면 agent 승인이 거절되고, buyer가 intent를 취소·환불한 뒤 새 계약/intent로 다시 시작해야 한다. 같은 intent에서 유효하지 않은 quote 다음에 다른 quote를 받는 marketplace UX는 아직 지원하지 않는다.

## 검증 게이트

1. **시뮬레이터:** 유효 quote만 승인; 비공개 최대 단가/총액 초과, 다른 seller/agent/recipient, policy·intent salt 변조, 마감, 잘못된 수량, 중복 승인·청구, 승인 뒤 취소를 거절. buyer escrow와 seller 지급+buyer 환불의 총합이 일치한다.
2. **배포 가능성:** 새 계약을 SILENCE와 별도 artifact로 컴파일하고 Local Devnet에서 배포한다. 1010 블록 한도라면 같은 artifact를 재시도하지 않고 크기/회로를 진단한다.
3. **실제 지급:** 가치 없는 토큰 mint→고정 lot escrow→seller quote→정책 proof→seller claim→buyer remainder claim을 끝까지 실행하고 두 지갑 잔고·receipt·ledger를 독립 조회한다. 실패 거래는 체인 상태와 자금이 바뀌지 않았음을 검증한다.
4. **브라우저/API:** 체인 경로가 통과하기 전에는 실행 버튼을 열지 않는다. observer 화면은 무엇이 공개되고 어떤 상한이 숨겨지는지 실제 public ledger에 맞춘다.
5. **제출 문구:** SILENCE의 Local Devnet 성공을 VeilIntent의 성공으로 전용하지 않는다. repo/README/폼/데모가 같은 검증 범위를 말해야 한다.

### 9/26 12:54 KST 실증 판정

| 게이트 | 결과 | 남은 범위 |
|---|---|---|
| 1. 시뮬레이터 | **14/14 PASS**, 잘못된 quote/권한·몫/나머지 witness·수취인·재실행 거절 | 사전 정의된 fixture 범위의 검사이며 보안 감사 아님 |
| 2. Local Devnet 배포 | **PASS**, 7회로 계약 배포 block 4222 | Preprod 배포 없음 |
| 3. 자금 흐름 | **PASS**, mint 4225 → intent 4230 → seller quote 4234 → agent approve 4238 → seller claim 4242 → buyer change claim 4246. 별도 인덱서 조회 7/7, 최종 ledger, 새 프로세스의 지갑 잔고 seller100/buyer50 확인 | 실제 상품 인도·두 자산 원자 교환, 실자산, 독립 agent fee signer, 브라우저 거래 없음 |
| 4. 웹·API | **정적 증거 데모 PASS, 브라우저 거래 미검증** | [공개 GitHub Pages](https://diveyreadytodive-star.github.io/veil-intent/)의 중앙 결제 카드는 기록된 결과만 재생한다. 별도 Evidence 화면에 Local Devnet 영수증 7건과 프라이버시 경계를, Simulator 화면에 브라우저 전용 정책 검사를 둔다. 외부 영수증 로딩, 데스크톱·390px 모바일 배치, 비공개 입력 삭제, 브라우저 오류 로그 0을 확인했다. 지갑 연결·새 proof·거래 제출 기능은 없다. |
| 5. 제출 | **미제출** | 새 README·덱·영상·폼의 동일 주장, Academy 파일 첨부와 실제 제출 영수증 필요 |

현재 가장 큰 외부 의존은 테스트 지갑의 DUST·Local Devnet 연결, seller/agent가 각각 자기 비밀을 안전하게 보관하는 실행 도구, Google Slides/영상/폼 제출이다. 사용자 인증서 파일은 저장소에 넣지 않는다.
