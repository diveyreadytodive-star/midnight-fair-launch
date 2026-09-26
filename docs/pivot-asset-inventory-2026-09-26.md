# SILENCE 피벗 전 코드 자산 인벤토리

기준: **2026-09-26 11:55 KST**. 이 문서는 새 주제를 고를 때 재사용 가능성과 검증 수준을 빠르게 판단하기 위한 스냅샷이다. 서로 다른 실험의 성공을 하나의 완성된 제품으로 합치지 않는다. 모든 체인 자산은 가치 없는 테스트 토큰이다.

| 자산 | 위치 | 검증된 범위 | 다음 제품에서 재사용할 부분 |
|---|---|---|---|
| Midnight 계약·Local Devnet 실행 골격 | `contracts/`, `src/chain/`, `scripts/test-local-chain.ts` | 본 계약의 고정 공개 담보 1,000 수탁·비공개 조건 commitment·소유자 종료가 실제 Local Devnet에서 확정. 루트 컴파일/타입 검사/58개 테스트 통과. | Compact 빌드, 지갑·인덱서·proof server 연결, 거래 영수증/ledger readback, 테스트 복구 패턴. 본 계약을 완성된 perp로 재사용하지 않는다. |
| 비밀 조건·권한 패턴 | `contracts/silence.compact`, `spikes/two-stage-claim/` | 잘못된 owner 비밀·변조 조건·중복 종료 거절; 다른 shielded 키를 쓰는 운영자 종료→소유자 후속 청구가 실제 체인에서 확정. | 신원/수취인/조건 commitment, 도메인 분리 secret, 운영자 조치와 소유자 수취 분리. 단, 운영자 거래 수수료는 테스트 runner에서 owner DUST 키로 후원했다. |
| 공개 오라클 + 비공개 위험 판정 | `spikes/oracle-risk/`, `spikes/integrated-risk-custody/` | P90 보호 종료와 P84 청산 조건이 별도 계약의 실제 Local Devnet proof에서 확정. 가격 순서/시각·운영자 권한 시뮬레이터 검사. | 오라클 게시자 capability, quote freshness, private witness predicate, 공개 상태 읽기. 해당 계약은 손실과 관계없이 원금 전액 반환하므로 정산 코드로 재사용하지 않는다. |
| 코인 분할·LP 잔돈 회계 | `spikes/lp-reserve/`, `spikes/lp-claim-discriminator/` | 독립 정적 계약에서 owner 800/LP 200과 owner 1,200/LP 잔돈 300의 후속 지출이 Local Devnet에 확정. | `sendShielded` 부분 지급, `writeCoin` 잔돈 인덱싱, LP 청구/영수증 검증. 지급액은 호출자 지정이었으므로 오라클 결박/경제 규칙은 새 제품에서 다시 설계해야 한다. 원래 복합 `claim`의 `/check` 400은 미해결. |
| 통합 정산 설계·시뮬레이터 | `spikes/perp-settlement/` | Compact 15회로 컴파일, strict TypeScript, 17/17 시뮬레이터·복구 테스트. P90=480m/P84=180m/P110=1,480m 지급을 TS 계산기와 대조. LP 권한·미개설 취소·0 지급 finalizer 포함. | 정수 손익 공식, 권한·LP 회계 음성 테스트, 정적 지급 분기 연구. **실제 Local Devnet 배포는 `1010: Transaction would exhaust the block limits`로 거절**돼 통합 거래는 한 건도 없음. 같은 artifact의 무작정 재배포 금지. 원본 복구 기록은 `.local/`에 보존. |
| 위험 엔진 | `src/risk/`, `src/engine/` | 정수 계산·보호 종료/청산 분기·지속화/재시도 단위 검사 통과. | 체인과 독립된 위험 정책 테스트, idempotency와 관측 로그. 실제 SILENCE 체인 거래 adapter는 연결되지 않았고 pending 보호 종료가 청산을 막는 경우가 있다. |
| 암호화된 파일 상태 저장 | `src/` 및 대응 테스트 | AES-256-GCM, 0600 원자 쓰기, 변조·오키 거부, 단일 writer 잠금의 컴포넌트 검사. | private witness/운영 상태 저장 패턴. 제품 서비스와 통합 및 무인 재시작까지 증명하지 않았다. |
| 웹·API 골격 | `web/`, `src/server.ts`, `src/api/` | 로컬 화면 렌더와 API 인증/입력 경계·개인 DOM 제거 테스트. | 거래 화면의 시각 언어, read-only 지갑 연결·접근 제어 구조. 주문 버튼은 비활성, 브라우저 실제 서명/체인 adapter/외부 데모 URL 없음. |
| 공개 검증·설명 자료 | `docs/evidence/`, `docs/verification-status.md`, `artifacts/output/` | 공개 GitHub와 `midnightntwrk` 토픽, 원격 fresh clone 설치/컴파일/테스트, Local Devnet receipt JSON, 6장 PPTX 초안. | 새 주제에 맞는 설명 형식과 증거 구분 원칙. SILENCE 특정 주장·숫자·영상/슬라이드는 새 주제에 그대로 전용하면 안 된다. |

## 바로 재사용하면 안 되는 주장

- **완성된 perp DEX, 온체인 주문 체결, 다수 LP 공유 풀:** 구현되지 않았다. 현재 통합 계약은 배포조차 막혔다.
- **완전 비공개 포지션/거래 이력:** 고정 담보, 가격, 거래 시각, 정적 정산 회로명/코인 잔액이 보인다. 종료 뒤 방향과 손익을 추론할 수 있다. 운영자는 포지션 원문을 안다.
- **독립 운영자·실거래 청산:** 테스트 runner가 owner DUST 키로 운영자 수수료를 후원했고, 별도 위험 계약은 전액 환급한다.
- **Preprod 사용 가능:** 5,000 tNIGHT 입금과 SDK 동기화는 확인했지만 DUST 등록 거래가 RPC 오류로 확정되지 않아 DUST 0, 제품 Preprod 거래 0이다.
- **배포 가능한 15회로 정산:** 시뮬레이터 통과와 달리 첫 Local Devnet 배포가 노드 블록 자원 한도에서 거절됐다. 실패 시도는 `recovery-required` 보호 기록에 잠겨 있다.

## 피벗 시 권장 활용 순서

1. 새 제품이 요구하는 **비공개 입력과 공개해야 할 검증 결과**를 먼저 한 문장으로 정한다.
2. 가장 가까운 위 spike **한 개**에서 필요한 Compact 권한·코인 패턴만 복사하고, 원래 제품의 포지션/LP 가정을 제거한다.
3. exported 회로 수와 배포 거래 비용을 초기에 검사한다. 15회로 통합 계약은 Local Devnet 배포에서 실패했다. 여러 계약으로 나누면 상태/자금의 원자성과 권한 경계를 다시 증명해야 한다.
4. 시뮬레이터 결과는 실제 proof·receipt·지갑 잔고와 분리해 기록한다. 새 제품의 핵심 흐름을 최소 1회 Local Devnet에서 끝까지 실행한다.
5. 새 주제의 README/피치/영상에서 기존 SILENCE 성공 영수증을 제품 완료 증거로 재사용하지 않는다. 기술 선행 실험이라고 표시한다.

공개 저장소에 넣지 않는 `.local/`, 지갑 seed·비밀번호·pending 복구 기록, 생성된 proving key와 Preprod 개발 지갑은 이번 스냅샷 커밋에서 제외한다. 실제로 무엇이 최종 푸시됐는지는 GitHub의 커밋 해시를 별도로 확인한다.
