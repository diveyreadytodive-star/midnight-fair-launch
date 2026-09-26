# SILENCE project deck draft

**Status:** Local, editable 6-slide PowerPoint draft. The Tally field asks for a Google Slides link; no Google Slides copy or public link exists yet.

| Slide | Purpose | Speaker timing |
|---|---|---:|
| 1. SILENCE | State the public-position privacy problem and label the prototype honestly. | 0:00–0:20 |
| 2. Public positions as signals | Explain how public address and chain data may reveal clues about direction, size, and liquidation risk. Scope the goal to reducing liquidation-map exposure while a position is open. | 0:20–0:48 |
| 3. Trust boundary | Show that traders and the operator risk engine can see position details, while public observers see fixed collateral, coin index, commitments, and timing. Keep the single main-product open-field scan separate from actual G2 risk-custody chain evidence that public quotes reveal Long after close. | 0:48–1:16 |
| 4. Local Devnet evidence | Show actual deploy, test mint, commitment, and owner-close receipts at blocks 153, 156, 160, and 164, plus owner shielded balance 0 to 1,000 and rejected wrong-secret/replay attempts. | 1:16–1:58 |
| 5. Current web interface | Use the actual local headless screenshot and call out the unavailable oracle, disabled order flow, and public fixed test lot. | 1:58–2:23 |
| 6. G2 and M2 Local Devnet milestones | Show actual G2 P90/P84 risk-close and owner-claim receipts with Long inferable after close, plus M2 static loss/profit payout and reserve-change receipts. Label both as separate feasibility spikes, not a complete perp or main-product integration. | 2:23–3:00 |

G2 integrated risk-custody receipts prove two separate Local Devnet paths: P90 open/riskClose/ownerClaim at blocks 989/995/999 and P84 at 1012/1019/1023. Public 100k entry and 90k/84k adverse close quotes let observers infer Long after close. The owner receives the full fixed 1,000 units regardless of loss; this is not PnL settlement. The G2 spike has no owner self-close and is not integrated into the main SILENCE contract.

M2 LP diagnostics prove static Local Devnet movement only: owner 800 plus later LP 200 on the loss path at blocks 2855/2859; owner 1,200 plus a reserve change of 300 that the LP later spent at blocks 2909/2913 on the profit path. The caller supplies each public payout and the exported circuit name reveals the payout regime. These tests do not bind payouts to an oracle or validate PnL/LP economics. The original compound claim still fails proof-server `/check` with HTTP 400. The G2/M2 runners used the owner/genesis DUST key in the same test process for fee sponsorship. Browser and Preprod product flows remain unverified.

The deck's privacy goal is limited to **reducing active-position liquidation-map exposure**. G2 confirms after-close Long inference on a separate actual Local Devnet spike, not on the main product contract. The deck makes no lifetime trading-history privacy claim.

## Sources used in speaker notes

- [README](https://github.com/diveyreadytodive-star/silence/blob/main/README.md)
- [Security boundary](https://github.com/diveyreadytodive-star/silence/blob/main/docs/security-boundary.md)
- [Phase 1 Local Devnet evidence](https://github.com/diveyreadytodive-star/silence/blob/main/docs/evidence/product-phase1-local-devnet.md)
- [Verification ledger](https://github.com/diveyreadytodive-star/silence/blob/main/docs/verification-status.md)
- [Local headless web screenshot evidence](https://github.com/diveyreadytodive-star/silence/blob/main/docs/evidence/web-local-headless.md)
- [G2 Local Devnet P90/P84 receipts](https://github.com/diveyreadytodive-star/silence/blob/main/spikes/integrated-risk-custody/docs/evidence/local-chain-risk-custody.json)
- [G2 risk-custody flow and privacy boundary](https://github.com/diveyreadytodive-star/silence/blob/main/spikes/integrated-risk-custody/README.md)
- [M2 static loss receipts](https://github.com/diveyreadytodive-star/silence/blob/main/spikes/lp-reserve/docs/evidence/diagnostic-loss-static-local-chain.json)
- [M2 static profit receipts](https://github.com/diveyreadytodive-star/silence/blob/main/spikes/lp-reserve/docs/evidence/diagnostic-profit-static-local-chain.json)
- [M2 LP reserve limits and compound claim failure](https://github.com/diveyreadytodive-star/silence/blob/main/spikes/lp-reserve/README.md)

The public repository is now available on `main`; the listed source paths resolve after the first source push. The PPTX contains a timed Korean speaker outline and these source URLs in its slide notes.
