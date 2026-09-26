# VeilIntent 3분 데모 대본 초안

**상태:** 촬영용 초안. 메인 결제 카드의 버튼은 완료된 Local Devnet 거래를 짧게 **재생**하며 새 transaction을 보내지 않는다. Evidence 화면에서 7개 영수증을 확인한다. 별도 browser-only policy simulator는 Compact proof를 만들지 않는다. 영상 URL·Google Slides 링크·최종 제출 영수증은 아직 없다.

공개 웹 데모: https://diveyreadytodive-star.github.io/veil-intent/ — 외부 HTTP 200과 실제 영수증 7건 로딩을 확인했다. 화면에 보이는 데모는 정적 기록이며 새 거래를 실행하지 않는다.

| 시간 | 화면 | 말할 내용 |
|---|---|---|
| 0:00–0:25 | 문제와 시장 가설 | “판매자 견적이 허용 범위인지 검증하려고 구매자의 최고 허용 가격을 공개하면 협상 상한이 드러납니다. VeilIntent는 이 상한을 감춘 채 견적 승인과 실제 지급을 검증합니다. 이런 보호를 원하는 treasury·agent 운영자가 있을지는 아직 고객 검증이 필요한 가설입니다.” |
| 0:25–0:55 | 중앙 결제 카드 | “기록된 흐름의 구매자 예치는 가치 없는 테스트 토큰 150, 판매자 공개 견적은 수량 50 × 단가 2로 총 100입니다. 구매자의 정확한 per-intent 상한은 카드에도 공개 증거에도 나오지 않습니다.” |
| 0:55–1:20 | 기록 재생 버튼과 성공 화면 | “‘Verify & release payment’는 새 증명이나 거래를 실행하지 않습니다. 이미 완료된 Local Devnet 지급을 짧게 재생합니다. 완료 화면의 판매자 100과 구매자 반환 50은 별도로 다시 읽은 지갑 잔고입니다.” |
| 1:20–2:05 | 별도 Evidence 화면 | “Evidence에서 확정된 기록 일곱 건을 확인합니다. 배포 4222, 토큰 발행 4225, intent 예치 4230, seller quote 4234, 정책 승인 4238, seller claim 4242, buyer 잔액 claim 4246입니다. 거래 ID와 블록을 별도 indexer로 다시 확인했습니다.” |
| 2:05–2:30 | 공개·비공개 경계 | “공개 관찰자는 예치150과 견적100을 보므로 숨긴 상한의 범위를 추정할 수 있습니다. 정확한 최대 단가·총액은 공개 증거에 없습니다. 이는 제한된 필드 프라이버시이며 원시 거래 전체의 프라이버시 감사 결과는 아닙니다.” |
| 2:30–2:55 | 검증 범위와 다음 가설 | “검증된 것은 가치 없는 테스트 토큰으로 한 구매자·한 판매자 사이에 이뤄진 단방향 payment입니다. 상품 인도나 atomic swap, live wallet, Preprod, 독립 agent 서비스는 없습니다. Agent는 LLM이 아닌 결정적 테스트 prover입니다. AI가 intent를 만들거나 treasury·agent 시장에 쓰이는 것은 향후 가설이며 수요는 검증되지 않았습니다.” |

## 촬영 전 증거 확인

- [ ] [증거 JSON](../spikes/veil-intent/docs/evidence/local-devnet-veil-intent.json)의 실제 거래 7건·블록이 화면에 표시되는 값과 일치한다.
- [ ] 메인 버튼은 **기록된 결과 재생**, Evidence의 7단계는 **기록된 Local Devnet 영수증**, 별도 policy checker는 **browser-only simulation**이라고 화면과 음성으로 분명히 구별한다.
- [ ] replay가 새 transaction을 제출하지 않고, 시뮬레이션이 Compact proof를 생성하지 않는다고 말한다.
- [ ] treasury/agent 수요는 검증되지 않은 시장 가설이고, AI intent 생성은 미래 확장 가능성이라고 설명한다.
- [ ] 보호된 `.local/`, 비밀 정책값, 지갑 seed·비밀번호·개인 인증서는 녹화에 나오지 않는다.
- [ ] 초반 25초 안에 문제를 말하고 3분을 넘지 않는다.
- [ ] 최종 공개 영상 URL을 다른 브라우저/로그아웃 상태에서 열어 확인한다.
