# VeilIntent hackathon deck

**Status:** Editable local 6-slide PPTX with concise English slide copy and a timed Korean speaker outline in notes. This file is not a Google Slides copy, and no Google Slides URL is claimed.

| Slide | Topic | Timing |
|---|---|---:|
| 1. A Public Quote. A Hidden Ceiling. A Verified Payment. | Exact per-intent maximum unit price and total budget stay with the prover. Escrow and seller quote are public and narrow the possible range. The demo has no live wallet or AI. | 0:00–0:20 |
| 2. Verify the Quote. Keep the Buyer's Cap Private. | Defines the ceiling as the maximum unit price and total spend accepted for one intent. Treasury and agent operators are a **market hypothesis**, not validated users; demand remains untested. | 0:20–0:45 |
| 3. One Intent. One Seller. One Payment. | One buyer escrows 150 test units; one seller posts a public quote for 50 units at $2 each; Compact approval checks private per-intent caps; seller claims 100 and buyer claims 50 change. | 0:45–1:20 |
| 4. Compact Checks the Buyer Ceiling | The buyer ceiling means the maximum price per unit and total amount accepted for this intent. Private witness lists those limits, nonce/salt, and agent capability; quote quantity/price/total, escrow, deadline, and status are public. Public amounts narrow the range; this is not full transaction anonymity. | 1:20–1:55 |
| 5. One Payment Completed on Local Devnet | Interactive seven-step replay of recorded evidence: deploy 4222, mint 4225, intent 4230, quote 4234, approve 4238, seller claim 4242, buyer remainder claim 4246. Independent indexer check: 7/7. Separate-process balances: seller 100, buyer 50. Replay submits no new transaction. | 1:55–2:30 |
| 6. What This Verified Flow Does Not Establish | One-way test-token payment only; no atomic swap, seller asset delivery, live wallet, browser transaction, or Preprod. The agent is a deterministic test prover, not an LLM; AI-generated intents are future work. Treasury/agent demand and PMF are untested. | 2:30–3:00 |

The evidence covers one buyer, one approved seller, one intent, and one one-way payment using valueless Local Devnet tokens. The public escrow lot is 150 and the actual quote is 100. These public values reveal a range for the buyer's private spending cap. Policy limits are known to the trusted prover. The acceptance check inspected in-memory ledger fields; it is not a raw-transaction, timing, or recipient privacy audit.

Keep the validation counts separate: VeilIntent has **14/14 simulator and recovery tests**; the repository-wide run is **74/74 total**, comprising those 14 plus 60 existing `tests/` and `web/` cases. The Local Devnet result is separate evidence: seven finalized receipts and 100/50 wallet readbacks. These test and chain counts do not validate treasury/agent product demand. The browser policy checker is a separate simulation; it does not generate a Compact proof or submit a transaction.

The contract's approval circuit does not take the buyer wallet seed, but the Local Devnet runner held buyer, seller, and solver test seeds in one process, and the buyer genesis wallet sponsored DUST. This does not demonstrate independent agent/solver services. No seller asset is escrowed or delivered, so VeilIntent is not an atomic asset swap. The project has no browser order flow, no Preprod product transaction, and no customer PMF evidence.

Latch already occupies the broad category of private AI-agent spending policies. VeilIntent's evidence-backed distinction is narrower: it checks a public seller quote against a hidden per-intent buyer ceiling, then completes a one-way shielded payment and buyer remainder claim. A treasury/agent marketplace is a future product hypothesis, and AI intent generation is a possible future extension. The deck does not claim that private agent spending caps are unique to VeilIntent.

## Sources

- [Implementation decisions and Local Devnet milestones](https://github.com/diveyreadytodive-star/veil-intent/blob/main/docs/veil-intent-implementation-decisions.md)
- [Compact contract](https://github.com/diveyreadytodive-star/veil-intent/blob/main/spikes/veil-intent/contracts/veil_intent.compact)
- [VeilIntent spike and limitations](https://github.com/diveyreadytodive-star/veil-intent/blob/main/spikes/veil-intent/README.md)
- [Sanitized Local Devnet receipts](https://github.com/diveyreadytodive-star/veil-intent/blob/main/spikes/veil-intent/docs/evidence/local-devnet-veil-intent.json)
- [Midnight agentic intent context](https://midnight.network/blog/midnight-city-simulation-live)
- [Midnight's August 2026 winners post describing Latch](https://midnight.network/blog/celebrating-seven-winners-from-mlh-x-midnight-july-hack)
- [Latch Devpost project](https://devpost.com/software/latch-23ku8j)
