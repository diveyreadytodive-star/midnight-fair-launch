# VeilIntent hackathon deck

**Status:** Editable local 6-slide PPTX with concise English slide copy and a timed Korean speaker outline in notes. This file is not a Google Slides copy, and no Google Slides URL is claimed.

| Slide | Topic | Timing |
|---|---|---:|
| 1. Give agents a spending rule | VeilIntent as a policy rail for one per-intent payment. The demo uses a simulated test-agent role, not an LLM. | 0:00–0:20 |
| 2. Agent Spending Needs a Clear Boundary | Problem hypothesis: broad wallet-key delegation, repeated manual approvals, and public spending caps each have a cost. Customer demand and PMF remain untested. | 0:20–0:45 |
| 3. One Intent. One Seller. One Payment. | One buyer escrows 150 test units; one seller posts a public quote for 50 units at $2 each; Compact approval checks private per-intent caps; seller claims 100 and buyer claims 50 change. | 0:45–1:20 |
| 4. Compact Checks Private Spending Caps | Private witness lists the maximum unit price, maximum total budget, intent nonce/salt, and agent secret. Deadline and the submitted quote quantity/price/total are public. | 1:20–1:55 |
| 5 | Actual Local Devnet path: deploy 4222, mint 4225, intent 4230, quote 4234, approve 4238, seller claim 4242, buyer remainder claim 4246. Independent indexer check: 7/7. New-process balances: seller 100, buyer 50. | 1:55–2:30 |
| 6. What This Verified Flow Does Not Establish | Trust, privacy, and product boundaries: one-way test payment only; simulated agent role; public quote/escrow; no atomic swap, browser/Preprod flow, reusable daily mandate, or PMF evidence. | 2:30–3:00 |

The evidence covers one buyer, one approved seller, one intent, and one one-way payment using valueless Local Devnet tokens. The public escrow lot is 150 and the actual quote is 100. These public values reveal a range for the buyer's private spending cap. Policy limits are known to the trusted prover. The acceptance check inspected in-memory ledger fields; it is not a raw-transaction, timing, or recipient privacy audit.

The contract's approval circuit does not take the buyer wallet seed, but the Local Devnet runner held buyer, seller, and solver test seeds in one process, and the buyer genesis wallet sponsored DUST. This does not demonstrate independent agent/solver services. No seller asset is escrowed or delivered, so VeilIntent is not an atomic asset swap. The project has no browser order flow, no Preprod product transaction, and no customer PMF evidence.

## Sources

- [Implementation decisions and Local Devnet milestones](https://github.com/diveyreadytodive-star/veil-intent/blob/main/docs/veil-intent-implementation-decisions.md)
- [Compact contract](https://github.com/diveyreadytodive-star/veil-intent/blob/main/spikes/veil-intent/contracts/veil_intent.compact)
- [VeilIntent spike and limitations](https://github.com/diveyreadytodive-star/veil-intent/blob/main/spikes/veil-intent/README.md)
- [Sanitized Local Devnet receipts](https://github.com/diveyreadytodive-star/veil-intent/blob/main/spikes/veil-intent/docs/evidence/local-devnet-veil-intent.json)
- [Midnight agentic intent context](https://midnight.network/blog/midnight-city-simulation-live)
