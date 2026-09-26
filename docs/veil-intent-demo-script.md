# VeilIntent 3분 데모 대본 초안

**상태:** 촬영용 초안. 화면의 7단계 replay는 기록된 Local Devnet 영수증을 보여주며 새 transaction을 보내지 않는다. 정책 checker는 browser-only simulation이며 Compact proof를 만들지 않는다. 영상에서는 이 둘과 실제 체인 증거를 분명히 구별한다. 영상 URL·Google Slides 링크·최종 제출 영수증은 아직 없다.

공개 웹 데모: https://diveyreadytodive-star.github.io/veil-intent/ — 외부 HTTP 200과 실제 영수증 7건 로딩을 확인했다. 화면에 보이는 데모는 정적 기록이며 새 거래를 실행하지 않는다.

| 시간 | 화면 | 말할 내용 |
|---|---|---|
| 0:00–0:25 | 문제와 시장 가설 | “판매자 견적이 허용 범위인지 검증하려고 구매자의 최고 허용 가격을 공개하면 협상 상한이 드러납니다. VeilIntent는 이 상한을 감춘 채 견적 승인과 실제 지급을 검증합니다. 이런 보호를 원하는 treasury·agent 운영자가 있을지는 아직 고객 검증이 필요한 가설입니다.” |
| 0:25–0:55 | Buyer intent와 공개 경계 | “기록된 Local Devnet 흐름에서 구매자는 가치 없는 테스트 토큰 150을 예치하고, 정확한 per-intent 한도는 prover가 아는 비공개 조건으로 둡니다. 판매자는 수량 50, 개당 2, 총액 100의 견적을 공개합니다. 150 예치와 100 견적도 공개되므로, 숨긴 한도의 가능한 범위까지 완전히 감춰지는 것은 아닙니다.” |
| 0:55–1:20 | 브라우저 정책 시뮬레이션 | “이 입력 화면은 별도 browser-only simulation입니다. Compact proof를 만들거나 지갑에 연결하거나 거래를 제출하지 않습니다. 실제 증거는 지금부터 재생할 기록된 Local Devnet 영수증입니다.” |
| 1:20–2:05 | 7단계 Local Devnet replay | “화면은 실제로 확정된 기록 일곱 건을 재생합니다. 배포 4222, 토큰 발행 4225, intent 예치 4230, seller quote 4234, 정책 승인 4238, seller claim 4242, buyer 잔액 claim 4246입니다. 이 버튼은 과거 영수증을 보여주며 새 거래를 보내지 않습니다. 별도 indexer로 7건 모두 다시 확인했습니다.” |
| 2:05–2:30 | 지갑 잔고 재조회 | “새 프로세스에서 지갑을 다시 읽었을 때 seller는 100, buyer는 50을 받았습니다. 정책 승인은 상태만 바꾸고, seller와 buyer가 각자의 고정 수취인으로 따로 claim했습니다.” |
| 2:30–2:55 | 검증 범위와 다음 가설 | “검증된 것은 가치 없는 테스트 토큰으로 한 구매자·한 판매자 사이에 이뤄진 단방향 payment입니다. 상품 인도나 atomic swap, live wallet, Preprod, 독립 agent 서비스는 없습니다. Agent는 LLM이 아닌 결정적 테스트 prover입니다. AI가 intent를 만들거나 treasury·agent 시장에 쓰이는 것은 향후 가설이며 수요는 검증되지 않았습니다.” |

## 촬영 전 증거 확인

- [ ] [증거 JSON](../spikes/veil-intent/docs/evidence/local-devnet-veil-intent.json)의 실제 거래 7건·블록이 화면에 표시되는 값과 일치한다.
- [ ] 7단계는 **기록된 Local Devnet 영수증 replay**, policy checker는 **browser-only simulation**이라고 화면과 음성으로 분명히 구별한다.
- [ ] replay가 새 transaction을 제출하지 않고, 시뮬레이션이 Compact proof를 생성하지 않는다고 말한다.
- [ ] treasury/agent 수요는 검증되지 않은 시장 가설이고, AI intent 생성은 미래 확장 가능성이라고 설명한다.
- [ ] 보호된 `.local/`, 비밀 정책값, 지갑 seed·비밀번호·개인 인증서는 녹화에 나오지 않는다.
- [ ] 초반 25초 안에 문제를 말하고 3분을 넘지 않는다.
- [ ] 최종 공개 영상 URL을 다른 브라우저/로그아웃 상태에서 열어 확인한다.
