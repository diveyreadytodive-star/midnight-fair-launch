# SILENCE — Private Perps on Midnight

**Experimental hackathon prototype. Test assets only. Not a live trading venue.**

Public on-chain perpetual exchanges can expose a trader's direction, size and liquidation risk. SILENCE is exploring a different boundary: the trader and a restricted risk engine know the position, while public observers verify valid margin and settlement actions without reading the full position. The MVP uses one BTC index market and a **fixed, publicly visible 1,000-unit test collateral lot** for every position. The new product contract has now passed one actual Local Devnet fixed-lot commit and owner-close cycle. In the tested open transaction and decoded ledger, side, notional, entry price, and guard were not observed; this targeted audit does not prove general unlinkability. The close circuit explicitly discloses the owner recipient key, and collateral amount and coin index are public. This is not yet an oracle-validated perpetual position.

The integrated oracle-risk [Local Devnet evidence](spikes/integrated-risk-custody/docs/evidence/local-chain-risk-custody.json) shows a further limit: its public entry price 100,000 and risk-close prices 90,000/84,000 reveal that both closed test positions were **Long** after risk-close, even though the side witness was not published. The current defensible privacy goal is to reduce an observer's **active-position liquidation map**, not to promise private lifetime trading history.

The operator risk engine can see position details and may delay or disclose them. Midnight proof verification can constrain invalid on-chain actions, but it cannot prove that an operator keeps information confidential or stays online. The demo oracle is permissioned and its price is test data. Protective exits are best-effort; price gaps, proof time, liquidity and operator downtime can still cause liquidation or LP loss.

## Current evidence

The [verification ledger](docs/verification-status.md) tracks what has passed and what remains open. In brief:

The [deadline milestones and Go/No-Go gates](docs/milestones-to-submission-2026-09-26.md) distinguish the verified risk-custody prototype from the missing economic perp settlement and submission work.

- [An earlier isolated Local Devnet escrow experiment](docs/evidence/escrow-local-chain.json) finalized test-token mint, shielded deposit and later release. The original test wallet read 0 then 1,000 shielded units. Its public ledger also exposed the stored amount, leading to the fixed public lot decision. This historical test fixture is not the SILENCE product contract; its local harness depends on a separate preserved checkout and is omitted from this standalone repository.
- [The SILENCE product Phase 1 Local Devnet evidence](docs/evidence/product-phase1-local-devnet.md) records actual deploy, mint, fixed-lot commit, and owner-close receipts; independent indexer hashes; an owner balance readback from 0 to 1,000 units; and live wrong-secret and replay rejection. The recipient disclosure and audit limits are documented with the receipts. This proves custody plus a private-terms commitment only, with no oracle, PnL, operator close, liquidation, or browser wallet.
- The TypeScript [risk reference](src/risk/calculator.ts) covers integer PnL, current-notional maintenance, fixed profit reservation, protective/liquidation predicates, payout caps and uncovered bad debt. Its tests do not prove Compact equivalence.
- [An isolated Compact risk-arithmetic spike](spikes/risk-circuit/README.md) compiles and passes 9/9 simulator tests, but its outputs are disclosed and it has no authenticated oracle or chain settlement. [A two-stage role-separation spike](spikes/two-stage-claim/README.md) passes 9/9 simulator tests **and an actual Local Devnet close/claim cycle**: a different shielded-key operator closed at block 573 without receiving collateral, and the owner claimed at 577. For this local test, the operator harness used the owner's DUST fee key in the same process; this does **not** prove production operation without owner wallet key access. The spike has no oracle/risk predicate or PnL and is not yet the product-contract path.
- [A composed oracle-risk spike](spikes/oracle-risk/README.md) compiles and passes 16/16 simulator cases with fixed policy, a demo publisher capability, ledger price/sequence/freshness, product-compatible price/atom units, private committed terms and one result-free protective/liquidation circuit. Independent review found and fixed a missing exit-cost boundary and unit mismatch. It has no asset movement or actual chain proof and is not integrated into the product contract.
- [An integrated risk-custody spike](spikes/integrated-risk-custody/README.md) compiles and passes 12/12 simulator cases **and actual Local Devnet P90/P84 risk-close/owner-claim cycles**. It combines fixed real test-coin escrow, an authenticated demo oracle, private risk predicates, operator close without payout and later owner claim. It refunds the full fixed lot regardless of PnL, offers no owner self-close if the operator disappears, and public open/close prices reveal the test positions' side afterward. It is a privacy/risk primitive, **not** a settled perp trade or safe product custody.
- [An LP reserve accounting spike](spikes/lp-reserve/README.md) now has actual Local Devnet **static loss and profit payout** paths. The owner received 800 test units and the LP later claimed 200; in a separate contract the owner received 1,200 and the LP later spent its indexed 300-unit reserve remainder. These payouts were **public caller-supplied test inputs**, not validated market PnL. The original compound `claim` still fails proof-server `/check` HTTP 400, and public circuit names/amounts reveal realized outcome. See [loss receipts](spikes/lp-reserve/docs/evidence/diagnostic-loss-static-local-chain.json), [profit receipts](spikes/lp-reserve/docs/evidence/diagnostic-profit-static-local-chain.json), and [failed compound circuit](spikes/lp-reserve/docs/evidence/break-even-local-chain-partial.json).
- The [operator risk-engine state machine](src/engine/risk-engine.ts) passed its persistence/retry unit cases under independent review. A pending protective close can still block a later liquidation; this is reported as an operational gap. Its adapter has not submitted a SILENCE on-chain close.
- The [web trading UI](web/index.html) is a presentation layer with no fabricated quote, balance or transaction. Order submission remains disabled until wallet authorization, Compact proof, settlement and chain readback are integrated.
- [Preprod faucet evidence](docs/evidence/preprod-faucet.md) confirms an on-chain 5,000 tNIGHT output to the separate development address. DUST registration and an external-network product transaction remain unverified.

## Run from a fresh checkout

Requires Node.js 22 or newer and network access for the pinned dependencies and official Compact installer. These commands passed in an isolated temporary copy without BlindAid, local wallet files, generated artifacts, or a preinstalled compiler:

```sh
npm ci
npm run setup:compiler
npm run compile
npm run typecheck
npm test
```

To inspect the current web interface locally, run `node --import tsx src/server.ts` and open `http://127.0.0.1:3000/`. The default server has no market-data or trading adapter: it reports unavailable data and keeps order submission disabled. The actual Phase 1 Local Devnet chain harness is `npm run test:chain` against the isolated Docker stack (`npm run chain:up`), but it additionally requires a **funded, valueless Local Devnet-only** `SILENCE_LOCAL_TEST_SEED` in the environment. Never pass a real wallet seed or the Preprod development wallet to that harness. The recorded receipts can be reviewed without any seed in [product Phase 1 evidence](docs/evidence/product-phase1-local-devnet.md).

## Development order

1. Extend the verified Phase 1 contract with an authenticated oracle/sequence check before treating a committed entry price as a valid position open.
2. Prove actual test-token LP reserve, oracle-bound owner settlement, and an operator risk-close path that changes `Open` to `ClosedUnclaimed` without sending shielded funds to an absent owner. The owner must later submit `claimPayout` and receive the bounded amount in their own wallet. Prove protective and liquidation predicates, strict recipient/amount bounds, and at-most-once close/claim. This separates automatic risk termination from later asset receipt because current [`sendShielded` behavior](https://docs.midnight.network/compact/standard-library/exports#sendshielded) does not notify a different user's wallet of a shielded payout.
3. Expand the raw transaction, ledger, API, and log disclosure audits, then independently read receipts and balances across separate owner and operator wallets.
4. Connect browser wallet/API flows only after those gates pass, test browser-close recovery, and then produce a fresh-clone runbook and 3-minute demo.

If any step fails, the final project description will narrow to the verified privacy/risk primitive rather than claiming a working perp DEX. See [security boundary](docs/security-boundary.md) and [verification status](docs/verification-status.md).

## Repository layout

| Path | Purpose |
|---|---|
| `contracts/`, `src/chain/` | New product Compact contract and headless Local Devnet chain adapter (Phase 1 verified) |
| `src/risk/`, `src/engine/` | Pure risk math and operator scheduling/recovery |
| `web/` | Browser interface and provisional API contract |
| `spikes/` | Isolated risk, two-stage claim, LP, oracle and integrated custody feasibility tests; each labels its own verification scope |
| `tests/`, `docs/evidence/` | Tests and environment-labeled verification |

The verified BlindAid project was used only to evaluate SDK/compiler and local-stack patterns. Its student-eligibility contract, wallet state and UI are not SILENCE's design. The public GitHub `main` checkpoint was independently cloned and passed `npm ci`, its own Compact setup, contract compile, typecheck, and 58/58 root tests. Wallet/browser trading, variable payout, and Preprod contract execution remain unverified.
