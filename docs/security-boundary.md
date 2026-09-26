# SILENCE security and privacy boundary

This document states the intended prototype boundary. A claim becomes verified only after the corresponding Compact circuit, transaction receipt, and independent public-ledger readback are recorded in `docs/evidence/`. Do not treat this document as an audit.

## Who can see the position?

| Party | Intended knowledge | Remaining power/risk |
|---|---|---|
| Trader | Full side, notional, entry, fixed collateral lot, guard, owner secret and payout address | Must protect wallet seed and local session. |
| SILENCE risk engine/operators | Full position witness and a separate close-only capability; never trader wallet seed | Can leak strategy data or delay execution. Contract rules must block healthy liquidation, payout redirection, and overpayment. Encryption at rest does not hide values from an authorized operator. |
| Public chain observer/other trader | Market, oracle, contract calls/timing, commitments, fixed public collateral lot (1,000 demo units), permitted aggregate risk slots | Entry-price range can be inferred from timestamp/oracle. Contract links and sparse activity may reduce anonymity. Side/exact notional/guard/precise liquidation line must be checked against raw ledger and API; not yet proved for the product contract. |
| Demo oracle administrator | Can publish permitted test price/sequence updates | Chain proof can establish consistency with the posted price, not that the posted price is a true market price. |

## Critical invariants to test

1. A position opens only with actual fixed-lot test collateral locked and a valid private parameter commitment. Notional must satisfy the published max leverage; oracle entry price and sequence must be bound at open.
2. Owner close and delegated protective/liquidation paths recompute the same commitment. A changed side, size, entry, owner recipient, guard or nonce fails.
3. Protective close is accepted only above maintenance and when the committed private buffer condition holds. Liquidation is accepted only at or below maintenance. The two paths settle at most once.
4. The risk engine has no wallet seed and cannot replace the original payout recipient or claim excess assets. The chain, not server-side JavaScript, checks the payout rule.
   Owner authorization must use a separate 32-byte owner-close secret preimage bound to a domain-separated commitment; never use `ownPublicKey()` as an authentication check. Midnight's [security guide](https://docs.midnight.network/guides/security-best-practices#authenticating-a-caller-with-a-derived-identity) says that witness result is prover-controlled. The operator gets a different close-only secret and must not receive the owner-close secret.

The owner-close secret is independent of the wallet seed. If the user loses it and no recovery/rotation path exists, owner close may become impossible. This test-only MVP must label recovery as unimplemented until a working encrypted backup or rotation path is verified; no real-value collateral belongs here.

The encrypted operator snapshot key is a separate server secret. Losing it can prevent the risk engine from recovering private position witnesses; a compromised key exposes strategies. The test-only file store fails closed when an existing writer lock remains after a crash, so an operator must verify the prior process is gone before removing that lock. A browser tab being closed is compatible with an always-on server; a server failure is **not** automatically recovered by this storage component.
5. Each accepted transaction is checked by receipt **and** updated contract/owner state. A submission, proof start, or UI success message is not confirmation.
6. The fixed public collateral lot does not itself fund unbounded LP bad debt. Gap losses, oracle errors, insurance deficit, stale prices and delayed proofs are measured and disclosed.
7. Public APIs and logs omit side, exact notional, guard, owner secrets and witness material. Authenticated private APIs are denied without wallet/session authorization. The current web order form stays disabled until real wallet/Compact/chain integration is independently verified.

The current product contract compilation required `disclose(ownerRecipient)` to create a `sendShielded` payout. Whether the recipient key is visible/linkable in the confirmed public transaction is **pending raw readback**. Do not claim wallet unlinkability or completely hidden trading history from a successful commitment-only open. The owner-close secret itself must remain private even when the payout target is disclosed.

Variable PnL payout and LP reserve updates are also pending privacy audit. Even if side and notional are hidden while a position is open, the close amount or an aggregate balance difference could reveal its outcome and approximate size after settlement. Until an actual variable-payout transaction is inspected, the strongest candidate claim is **active-position privacy**, not full lifetime trading-history secrecy.

There is also an **inference leak independent of raw witness bytes** in the [integrated risk-custody Local Devnet experiment](../spikes/integrated-risk-custody/docs/evidence/local-chain-risk-custody.json). Its public entry oracle price was 100,000 USD and the public risk-close prices were 90,000 and 84,000 USD; because risk-close requires an adverse move, those price pairs reveal that the closed test positions were Long even though the side witness was not published. A single exported `riskClose` circuit hides the branch name but does not hide this ex-post side inference. A fixed public lot and eventual variable payout can reveal more after settlement. Any pitch must distinguish private input storage from what a public observer can infer; this evidence does not support lifetime side/history privacy or anonymous trading.

Automated risk close and automatic wallet receipt are separate. [Midnight's `sendShielded` reference](https://docs.midnight.network/compact/standard-library/exports#sendshielded) says it currently creates no coin ciphertext when one user sends to another user; an operator-submitted shielded payout may not be discovered by the owner wallet. The Phase 2 candidate therefore records an irrevocable `ClosedUnclaimed` settlement while the owner is offline and lets the owner submit `claimPayout` on return. That would end market exposure automatically but defer actual wallet receipt. Neither transition is implemented or verified yet. A successful owner-self-close in Phase 1 does not prove the operator payout path.

## Known verified precursor and open gaps

An isolated Local Devnet escrow spike proved test-token mint, shielded deposit, separate-transaction release and receiving-wallet balance change. The same readback **exposed the stored coin value publicly**, leading to the fixed 1,000-unit public-lot MVP decision. [Escrow evidence](evidence/escrow-local-chain.json).

No product `openPosition`/`protectiveClose`/`liquidate` proof, LP solvency proof, browser wallet connection, or accessible public demo has yet been verified in this document. Update this paragraph only with corresponding evidence links and exact environment labels.
