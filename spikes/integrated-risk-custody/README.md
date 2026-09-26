# Integrated risk-custody simulator spike

This Compact 0.31.1 spike joins a shielded fixed-lot custody transition with an authenticated demo oracle and a private risk-close predicate. The simulator covers open → risk close into `ClosedUnclaimed` → one owner claim. It is a **risk-custody primitive, not a perp DEX**.

## Flow

1. The contract publishes a permissionless Local Devnet-only faucet circuit for one fixed test collateral lot (`1,000,000,000` atoms). `openPosition` consumes exactly that shielded coin, accepts only a fresh capability-authenticated oracle snapshot, and requires the private entry-price term to equal the current public oracle price.
2. Opening commits the side, notional, entry price, guard, owner secret commitment, per-position operator secret commitment, recipient commitment, fixed policy, and the opening quote's public price/sequence/timestamp. Terms and secrets are circuit inputs; the public ledger stores commitments and the fixed escrow coin.
3. The authorized risk operator may call one `riskClose` circuit with the original private terms and position salt. It checks either the private protective threshold or liquidation threshold and emits no risk result/mode. It makes no asset transfer and changes the public lifecycle to `ClosedUnclaimed`. The operator does not need the owner secret or recipient key; a real deployment would need to deliver/store the terms and salt securely for the risk service, which this spike does not wire up.
4. `ownerClaim` requires the original owner secret, terms, position salt, and original committed recipient. It sends exactly the fixed lot once to that recipient. No caller-selected destination is accepted.

There is intentionally no owner self-close. Without PnL computation and settlement, an owner close that returns the full lot would let a losing position bypass the economic risk rules. The current claim is only a custody demonstration after an authorized risk close: it returns the fixed lot in full and **does not account for PnL, loss, fees, funding, pool solvency, or liquidator rewards**. A real perp cannot use this release rule.

## Fixed demo policy and arithmetic

- Collateral: `1,000,000,000` atoms
- Maximum notional: `5,000,000,000` atoms
- Protocol fee: fixed `0`
- Maintenance: `500` basis points
- Estimated exit cost: fixed `20,000,000` atoms
- Profit cap: fixed `500,000,000` atoms, carried for future settlement only
- BTC price: `1,000,000` micro-USD ticks per USD; USD 100,000 is `100,000,000,000` ticks
- Loss PnL and maintenance round up; profit PnL rounds down
- Intermediate products use `Uint<128>` and constrained private quotient/remainder witnesses; rounded current notional must fit `Uint64`, matching the TypeScript risk reference
- The opening guard must be strictly below the initial post-maintenance, post-exit buffer. This avoids opening in a state that immediately qualifies for protective close.

At USD 100,000 entry and maximum notional, P90 yields `500,000,000` equity, `225,000,000` maintenance, and `255,000,000` post-maintenance/post-exit buffer. With a private `255,000,000` guard, protective close is accepted. P84 yields `200,000,000` equity against `210,000,000` maintenance and is accepted by the liquidation predicate. Both use the same circuit and reveal no public mode.

## Privacy and authority limits

- The latest oracle price, sequence and timestamp are public. The opening snapshot is copied to separate public fields and included in the position commitment, so later quote updates cannot rewrite the original entry context. Because opening requires `entryPrice == publicOraclePrice`, the entry price is inferable from that public quote.
- `isLong` is not plaintext in the ledger or circuit result, but this design still leaks direction semantically when a risk close occurs: a lower public mark than entry implies a losing long, and a higher public mark implies a losing short. Since `riskClose` succeeds only for an adverse protective/liquidation predicate, the public entry/close price pair lets observers infer the side after close. This spike therefore does **not** establish lifetime side privacy. At most, it explores concealing size/guard and delaying the side inference until a public close event; raw byte absence is not evidence that side cannot be inferred.
- Notional, guard, salts, owner secret and operator secret are absent from the simulated public ledger. The owner, operator, and recipient commitments are public hashes. The position side has the inference caveat above.
- The committed shielded recipient key is disclosed to `sendShielded` during owner claim. The claim output therefore does not hide the recipient from the transaction data.
- Oracle, operator and owner authorization use knowledge of domain-separated secret preimages, not `ownPublicKey()`. Proofs can be relayed; this does not bind the transaction submitter to the capability holder. The risk operator must receive and retain the original terms and position salt, but does not need the owner secret or recipient key. There is one oracle publisher and one operator secret, with no rotation, quorum, revocation or liveness design.
- The faucet is test-only. The fixed collateral's public value/coin metadata, simulator behavior, and later full-lot refund make no claim about private variable collateral or economically correct settlement.
- `npm test` compiles and runs only the Compact simulator. It does not generate a transaction proof, deploy to Local Devnet, or inspect an indexed raw transaction. On-chain privacy and spend evidence remain unverified.

Compact block-time freshness uses `blockTimeGte` and `blockTimeLt`, which compare the supplied Unix-seconds quote time with block time at block granularity; Compact exposes no readable `now` value. References: [Compact standard library](https://docs.midnightkorea.org/compact/standard-library/exports), [security best practices](https://docs.midnightkorea.org/guides/security-best-practices).

## Run

From this directory, run `npm test`. Tests use the pinned dependency installation from the parent repository and the cached Compact 0.31.1 compiler when available. No shared Local Devnet or Docker stack is started by this spike.

## Local Devnet acceptance runner

The runner is disabled by default and never starts, resets or restarts Docker. Its endpoints are hard-restricted to the configured loopback services. With the parent task's approval and the shared stack free, prepare a protected recovery bundle with `SILENCE_LOCAL_TEST_SEED=<32-byte valueless Local Devnet genesis seed> npm run test:chain -- --prepare-only`. This writes the owner/operator seeds, oracle/operator/owner capabilities, salts, storage passwords, planned terms and scenario state to `.local/integrated-risk-custody-recovery/recovery.json` (directory mode `0700`, file mode `0600`). Wallet private-state databases remain in protected subdirectories. The runner never reads `private-perps/.local/preprod-dev-wallet.json` or accepts a wallet-file path.

Run `npm run test:chain -- --preflight-only` next to sync both wallets read-only, verify distinct shielded keys, confirm the owner has Local Devnet DUST for fee sponsorship, and confirm the random operator wallet has no local native balance. It submits no transaction. Only after that evidence is reviewed should `npm run test:chain -- --execute` run the two contract scenarios. Every deployment, quote, mint, open, risk close and claim gets a persisted pending marker before submission and a finalized receipt/indexer record afterward. If a submission becomes uncertain or lacks a recorded tx identifier, the runner stops and preserves its full recovery bundle; it never regenerates keys or automatically retries an ambiguous transaction. The acceptance output records proof/balance/submit/receipt wall-clock timing so the 60-second oracle TTL can be assessed from real runs.

The successful run's first ordering published P100 before the collateral mint; the P100 and next risk-quote timestamps were exactly 60 host seconds apart in both scenarios, while each risk quote reached risk-close submission in under 20 seconds. That left little time margin for opening under a slow prover. The runner now mints and syncs collateral first, then publishes the opening quote immediately before `openPosition`, keeping the contract's 60-second stale-price rejection intact instead of widening freshness based only on a successful boundary case.
