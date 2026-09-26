# Perp settlement and LP reserve spike

This Compact 0.31.1 spike builds on the isolated risk-custody fixture. It locks one actual shielded trader coin of `1,000,000,000` atoms and one actual shielded LP reserve coin of `500,000,000` atoms, commits private position terms, verifies an authenticated public oracle quote, and recomputes the trader's settlement from Compact. Scope is one BTC/USD oracle index, exact-price/zero-spread test execution, one LP reserve slot, and one trader position. There is no public orderbook.

It is an accounting and proof feasibility spike, not a production perp DEX. Coins are permissionlessly minted, valueless Local Devnet test tokens; they are not BTC, NIGHT, or tNIGHT. BTC/USD is the public oracle index, while collateral and the LP reserve are test-token atoms. Local execution fees use DUST sponsored by the Local Devnet test genesis wallet. No market maker, liquidation auction, keeper network, variable fee index, or mainnet asset is implemented.

## Flow and authority

1. The constructor binds the domain-separated LP authority commitment and oracle publisher commitment. An arbitrary first funder cannot occupy the single LP reserve slot. `fundReserve` accepts the exact reserve-token coin only when its LP capability preimage matches the constructor commitment, and commits the LP recipient. The authorized LP can cancel and recover the reserve before any position is opened.
2. `openPosition` requires a fresh current public oracle quote, exactly `1,000,000,000` atoms of the collateral test token, and a notional no greater than `5,000,000,000` atoms. Entry price must equal the current quote. It commits side, notional, entry price, guard, owner, operator, LP identity and recipient commitments, the fixed policy, and opening quote snapshot. The policy's protocol fee is fixed at zero; no caller-supplied fee or funding fields exist. Opening rejects a protective guard already met at entry.
3. A separate operator capability can call `riskClose` only when the private protective or maintenance predicate holds. It stores that exact public oracle price/sequence/time as the settlement snapshot and moves the position to `ClosedUnclaimed`; it does not transfer either coin.
4. The owner can also call `ownerSelfClose` at a fresh authenticated oracle quote. It freezes that quote and applies exactly the same settlement math; there is no blanket full-collateral refund. The owner then chooses the static settlement circuit matching the Compact-computed result: `ownerSettleLoss`, `ownerSettleFlat`, `ownerSettleProfit`, `ownerSettleZero`, or `ownerSettleBadDebt`. No claim circuit accepts a payout, fee, cap, or oracle-price argument.
5. A zero-payout position has no incentive for the owner to submit a claim, so `finalizeZeroPayout(terms, positionSalt)` is permissionless after risk close/self-close. It recomputes the committed position and frozen quote, rejects any positive payout, retains the collateral coin in LP-claimable custody, and settles once. A holder of the private terms and salt can relay this proof; it cannot redirect the coin.
6. The LP can later claim the collateral remainder or unused reserve with its separate capability and committed recipient. Loss/shortfall does not draw from the profit reserve. The reserve backs profit only, matching `src/risk/calculator.ts`; bad-debt shortfall remains explicit and uncovered.

This does not guarantee LP liveness after a positive-payout risk close: if the owner never submits the appropriate static settlement claim, the position and its LP collateral remainder remain locked. A zero-payout finalizer is permissionless because no owner payout can be redirected; positive outcomes still need the owner recipient witness. The reserve can be canceled safely only before a position opens.

The M2 LP diagnostic found that five isolated `sendShielded` circuits (full, partial, change-write, variable payout, and separate reserve) finalized on Local Devnet, while a compound claim returned `/check 400`. This spike keeps each settlement outcome on its own static entrypoint and keeps the zero-payout path separate from all sends. The combined contract is simulator-verified; its M3 chain runner is prepared for review, but no M3 transaction has been submitted. Do not assume that multiple spends inside the static profit path will prove on Local Devnet until an acceptance run verifies it.

## Fixed policy and settlement math

- Collateral: `1,000,000,000` atoms
- LP reserve: `500,000,000` atoms, one real shielded test coin
- Maximum notional: `5,000,000,000` atoms
- BTC price: `1,000,000` micro-USD ticks per USD; entry at USD 100,000 is `100,000,000,000` ticks
- Maintenance: `500` basis points; close cost: `20,000,000` atoms
- Protocol fee: fixed `0`; no borrower/funding amount is caller supplied without an authenticated index
- Profit cap: fixed `500,000,000` atoms, equal to the funded reserve

PnL uses conservative signed-floor rounding: losses round away from zero and profits round down. Current notional and maintenance round up. Compact uses checked `Uint<128>` price products and private quotient/remainder witnesses; current notional is bounded to the TS reference's `Uint64` range. The settlement payout is `clamp(equity - exitCost, 0, collateral + profitCap)`. A positive profit above collateral spends the separate LP reserve up to the fixed `500,000,000` cap. A payout below collateral leaves the unused part of the trader coin in a separate LP-claimable shielded output. A negative pre-cap payout produces a shortfall number in the private Compact calculation, but the reserve does not cover that shortfall.

With zero accrued charges:

| Case | Side and mark | TS payout | Maintenance | Reserve effect |
| --- | --- | ---: | ---: | --- |
| P90 protective | Long, USD 90,000 | `480,000,000` | `225,000,000` | no reserve spend; `520,000,000` trader change is LP claimable |
| P84 liquidation | Long, USD 84,000 | `180,000,000` | `210,000,000` | no reserve spend; `820,000,000` trader change is LP claimable |
| Flat payout | Long, USD 100,000.40 | `1,000,000,000` | `250,001,000` | no reserve spend or change |
| Profit | Long, USD 110,000 | `1,480,000,000` | `275,000,000` | spends `480,000,000`; `20,000,000` reserve remainder is LP claimable |
| Profit cap | Long, USD 115,000 | `1,500,000,000` | `287,500,000` | spends all `500,000,000` reserve |
| Bad debt | Short, USD 130,000 | `0` | `325,000,000` | reports `520,000,000` shortfall; reserve remains `500,000,000` |

Tests differential-check arithmetic against `calculatePositionRisk` from `src/risk/calculator.ts`. Fees are fixed to zero because there is no authenticated accrual index; extra caller object fields such as `fundingIsCredit` are not part of the Compact terms and cannot manufacture LP-backed profit.

## What remains public or inferable

- Oracle entry/close prices, sequence numbers, timestamps, fixed collateral/reserve coin values and contract state are public.
- The side field is not disclosed directly, but the public entry/settlement price pair and adverse-close rule reveal the likely losing side after settlement. This is not lifetime side privacy.
- The static settlement selector (`ownerSettleLoss`, `ownerSettleFlat`, `ownerSettleProfit`, `ownerSettleZero`, or `ownerSettleBadDebt`) reveals the coarse outcome class. Shielded send circuit arguments explicitly disclose payout amounts and payout recipient openings in this test contract; this demo does not establish payout-amount or recipient privacy.
- Operator and owner capabilities are domain-separated secret preimages, not authenticated transaction signers. Calls can be relayed. The operator service must retain private terms and position salt to close risk.
- `finalizeZeroPayout` has no owner secret by design. It can only settle a zero payout under the committed terms and frozen snapshot; the contract never sends funds to its caller.
- The reserve backs profits only. The contract does not claim that `500,000,000` atoms can insure arbitrary market gaps or bad debt.
- Static selector names reveal loss/flat/profit/zero/bad-debt class, and shielded send arguments/coin remainders may reveal payout amounts. This settlement spike is not lifetime trading-history privacy.

## Verification

Run `npm test` in this directory. It compiles the Compact source, strict-typechecks the simulator and acceptance runner, and checks P90/P84, flat, profit, cap, bad debt, LP reserve remainder claims, static-path enforcement, owner/operator/LP authority, oracle freshness/replay, frozen settlement snapshots, zero-payout finalization, and full-refund bypass rejection. It also tests that execution refuses any manifest that is not pristine. The loopback-only runner uses a preserved `0700/0600` test-only recovery bundle and never starts or resets Docker. `--prepare-only` and `--preflight-only` do not submit transactions. Run `--execute` only after repository-lead review of the recovery manifest and read-only preflight; this prototype has no resume path and refuses any manifest with prior actions, a contract address, or a pending operation. Any proof/check, receipt, or readback failure stops execution and preserves the pending operation for manual reconciliation.
