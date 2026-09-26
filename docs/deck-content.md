# SILENCE project deck draft

**Status:** Local, editable 6-slide PowerPoint draft. The Tally field asks for a Google Slides link; no Google Slides copy or public link exists yet.

| Slide | Purpose | Speaker timing |
|---|---|---:|
| 1. SILENCE | State the public-position privacy problem and label the prototype honestly. | 0:00–0:20 |
| 2. Public positions as signals | Explain how public address and chain data may reveal clues about direction, size, and liquidation risk. Scope the goal to reducing liquidation-map exposure while a position is open. | 0:20–0:48 |
| 3. Trust boundary | Show that traders and the operator risk engine can see position details, while public observers see fixed collateral, coin index, commitments, and timing. Separate the single actual open-transaction inspection from a simulator design inference that public entry/close prices can reveal side after risk close. | 0:48–1:16 |
| 4. Local Devnet evidence | Show actual deploy, test mint, commitment, and owner-close receipts at blocks 153, 156, 160, and 164, plus owner shielded balance 0 to 1,000 and rejected wrong-secret/replay attempts. | 1:16–1:58 |
| 5. Current web interface | Use the actual local headless screenshot and call out the unavailable oracle, disabled order flow, and public fixed test lot. | 1:58–2:23 |
| 6. Two-key Local Devnet evidence | Show the actual open/operator-close/owner-claim receipts at blocks 570/573/577, owner balance 0 to 1,000, and operator balance 0. State that the operator's distinct Zswap key ran in a shared test process that also used the owner's `DustSecretKey` to sponsor DUST fees. | 2:23–3:00 |

Slide 6 proves the separate-key role and recipient boundary on a valueless Local Devnet spike. It does **not** prove an independently operated service with no owner-key access: the chain runner used the owner's `DustSecretKey` in the same test process. The spike has no oracle or risk predicate and lets an operator close early. Oracle pricing, risk-triggered close, PnL/LP settlement, integration into the main SILENCE contract, and browser trading remain unverified.

The deck's privacy goal is limited to **reducing active-position liquidation-map exposure**. A separate integrated risk-custody simulator design shows that public entry and close prices can reveal the losing side after risk close. That is a simulator analysis, not actual SILENCE product-chain evidence. The deck makes no lifetime trading-history privacy claim.

## Sources used in speaker notes

- [README](https://github.com/diveyreadytodive-star/silence/blob/main/README.md)
- [Security boundary](https://github.com/diveyreadytodive-star/silence/blob/main/docs/security-boundary.md)
- [Phase 1 Local Devnet evidence](https://github.com/diveyreadytodive-star/silence/blob/main/docs/evidence/product-phase1-local-devnet.md)
- [Verification ledger](https://github.com/diveyreadytodive-star/silence/blob/main/docs/verification-status.md)
- [Local headless web screenshot evidence](https://github.com/diveyreadytodive-star/silence/blob/main/docs/evidence/web-local-headless.md)
- [Two-stage Local Devnet receipts](https://github.com/diveyreadytodive-star/silence/blob/main/spikes/two-stage-claim/docs/evidence/local-chain.json)
- [Two-stage spike and limits](https://github.com/diveyreadytodive-star/silence/blob/main/spikes/two-stage-claim/README.md)
- [Fee sponsorship runner](https://github.com/diveyreadytodive-star/silence/blob/main/spikes/two-stage-claim/scripts/test-local-chain.ts)
- [Integrated risk-custody simulator privacy boundary](https://github.com/diveyreadytodive-star/silence/blob/main/spikes/integrated-risk-custody/README.md)

The public repository is now available on `main`; the listed source paths resolve after the first source push. The PPTX contains a timed Korean speaker outline and these source URLs in its slide notes.
