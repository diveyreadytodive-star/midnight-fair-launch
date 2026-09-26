# Oracle + private risk-close composition spike

This is an isolated Compact 0.31.1 **simulator feasibility spike** for the G2 combination: an authorized demo quote updates public oracle state, the trader commits private position terms, and an operator capability may close a position when one of two private risk predicates holds. It is not the product contract, does not custody or transfer collateral, and does not settle PnL.

The public ledger has the latest BTC quote, publisher timestamp and monotonically increasing sequence, the commitment to private position terms, and open/closed lifecycle flags. Quote time cannot move backwards; `riskClose` rechecks quote freshness. `riskClose` returns `[]`; the protective/liquidatable bit never enters ledger state, a return value, or an event. The user secret and operator secret are distinct domain-separated preimages. Neither role uses `ownPublicKey()` as authentication. The demo oracle and operator credentials are single-secret capabilities, so this does not establish a production oracle committee or operational key management.

Risk money uses exact atoms: fixed collateral `1,000,000,000`, max notional `5,000,000,000`, fixed fee `0`, maintenance `500` basis points, fixed exit cost `20,000,000`, and profit liability cap `500,000,000`. Price ticks match `src/risk/calculator.ts`: `1,000,000` ticks per USD, so BTC at USD 100,000 is `100,000,000,000` ticks. PnL is `notionalAtoms * abs(markTicks - entryTicks) / entryTicks`, with losses rounded up and gains down. Maintenance is rounded up. Notional is bounded at `5e9` and prices are `Uint<64>`; the largest raw product is below `2^97`, fitting `Uint<128>`. Rounded current notional is also constrained to `Uint64`, matching the TypeScript reference. Division is supplied as a private quotient/remainder witness and constrained by `q * denominator + r == numerator` and `r < denominator`. The fixed zero fee is included in equity computation; the profit cap is carried in the immutable policy and reserved for a future settlement circuit, which this spike does not implement.

The fixture opens long BTC at USD 100,000 (`100,000,000,000` ticks), maximum notional, and a private protective guard of `255,000,000` atoms. With zero accrued borrowing/funding costs, P90 gives `500,000,000` equity, `225,000,000` maintenance and `255,000,000` margin after maintenance and fixed exit cost, so it meets the guard. P84 gives `200,000,000` equity against `210,000,000` maintenance, so the liquidation predicate holds. The tests also run those exact-scale inputs through the product TypeScript calculator and compare its arithmetic and predicates. Both cases use the same risk-close circuit and produce only a closed lifecycle flag.

Opening requires the selected private guard to be strictly below the initial post-maintenance, post-exit buffer. A guard already met at entry would otherwise cause immediate protective closure on the first risk check; this spike rejects that configuration explicitly.

Oracle freshness uses Compact's `blockTimeGte` / `blockTimeLt` predicates, which compare a supplied Unix-seconds timestamp against current block time; Compact does not expose a readable `now` value. The comparison is block-time granular, not a wall-clock timer. Official references: [Midnight Korea Compact standard-library reference](https://docs.midnightkorea.org/compact/standard-library/exports) and [Midnight security best practices](https://docs.midnightkorea.org/guides/security-best-practices).

## Run

From this directory run `npm test`. Dependencies use the existing parent project's pinned installation. The compile helper uses the project's cached Compact 0.31.1 compiler (or accepts `COMPACTC` / `compact` on PATH). The simulator tests do not produce a transaction proof or establish deployment correctness.

## Explicit gaps

- The local transaction sender/caller does not bind the supplied oracle capability to a distinct chain signer. The proof authenticates knowledge of the secret; any relayer may submit that proof.
- There is one quote publisher, one operator capability and one singleton position. No quorum, revocation, rotation, multi-market concurrency or liveness policy exists.
- A valid but malicious authorized oracle can publish a wrong quote. This spike checks source capability, sequence and freshness, not external market truth or manipulation resistance.
- Closing is a lifecycle transition only. No collateral transfer, variable payout, reserve solvency, fee charging or LP accounting is implemented.
- Simulator privacy assertions inspect only explicitly disclosed ledger and return values. Raw submitted proof, indexed transaction and Local Devnet disclosure checks remain necessary before claiming on-chain privacy.
