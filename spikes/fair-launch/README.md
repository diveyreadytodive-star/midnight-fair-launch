# Fair Launch — four-slot sealed-bid auction

**Actual Midnight Local Devnet prototype using valueless test assets.** This is not a production token launch, a live market, or an investment service. The current contract fixes the sale inventory at 600 units, the reserve price at 8 TEST, four bidder slots, and a 5,000 TEST deposit lot per registered slot.

## Recorded Local Devnet run

The committed [evidence JSON](docs/evidence/local-devnet-fair-launch.json) records one completed Local Devnet run. It contains 20 successful transaction receipts from blocks 9380 through 9493: deploy, sale-token mint and funding, four payment-lot mints, four registrations, settlement, four refunds, two proceeds claims, and two token claims. The recorded run used the loopback Local Devnet endpoints and did not start or reset Docker.

The four slots settled at a uniform price of 10 TEST. The allocations were 300/300/0/0; refunds were 2,000/2,000/5,000/5,000 TEST. Independent wallet readback recorded payment balances of 2,000/2,000/5,000/5,000 TEST, sale-token balances of 300/300/0/0, and a 6,000 TEST treasury balance. All four refund claims and both winning token claims completed. These claims establish this specific test-asset run only.

The runner configured `commitWindowSeconds=480`, an **8-minute Local Devnet demo commit window**. The proposal's **30-minute product window is an intended setting only**; this run did not exercise 30 minutes. The runner also sets a 3,600-second post-commit open window. Do not describe the observed run as a 30-minute auction.

## Reproducing checks and the one-shot chain flow

Use Node.js 22 or newer. From the repository root, the reproducible compile, typecheck, and local test suite is:

```sh
npm ci
npm run setup:compiler
npm run compile
npm run typecheck
npm test
```

To create a **new, isolated** Local Devnet run, use a clean checkout that does not already contain this run's evidence file or recovery state, with the loopback Local Devnet services available. The commands are:

```sh
npm run test:fair-launch:chain -- --prepare-only
npm run test:fair-launch:chain -- --preflight-only
npm run test:fair-launch:chain -- --execute
```

Before `--prepare-only`, supply a 32-byte valueless Local Devnet genesis seed to `FAIR_LAUNCH_LOCAL_TEST_SEED` through a secure environment manager. Do not type the seed into shell history or a command line. `--prepare-only` writes the protected recovery manifest under `.local/fair-launch-recovery/` and does not access wallets, network, Docker, or submit transactions. `--preflight-only` checks the loopback services and distinct bidder/operator shielded keys without submitting a transaction. `--execute` submits the full chain flow and writes a new evidence file; it is one-shot. The runner refuses an existing evidence file, complete/recovery-required manifest, pending action, or existing lock. Never delete or overwrite evidence or protected recovery state to bypass these guards. The already completed checkout must not run `--execute` again. Never use a Preprod or real-wallet seed.

The [read-only web evidence summary](../../web/fair-launch-evidence.json) is generated from the full evidence file above; it is a convenient copy, not independent proof. The [Fair Launch page](../../web/fair-launch.html) has Explore, Create, and token detail views. Bid and claim controls remain disabled without a user wallet integration. The summary is recorded evidence, not a live replay.

## Local Devnet Create demo

The [verified launch catalog](../../web/fair-launch-catalog.json) now contains the original settled auction and two additional **valueless Local Devnet** test launches. `Midnight Moth Test` was created through the CLI and `Night Bloom Test` through the browser Create button. Each new contract was deployed, minted its own sale-token type once, and received its configured inventory; the six new receipts were re-queried from the indexer and the contract ledgers showed the expected funded inventory and metadata commitment. These launches have not completed bidder settlement; the 20-transaction auction result above belongs only to the original contract.

The Create endpoint is opt-in (`FAIR_LAUNCH_CREATE_ENABLED=1`), bound to a loopback server, and uses an operator's **Local Devnet test wallet** to submit transactions. It is not a permissionless launch signed by each creator's wallet. A new catalog card appears only after deploy, mint, fund, and ledger readback succeed. The image URL string is included in the metadata commitment, but remote image bytes are not pinned. The public/static page can browse verified launches and preview a draft; only the locally enabled API can actually create one.

## Preprod receipt recheck

The separate guarded Preprod deploy runner produced [public evidence](../../docs/evidence/preprod-launch-2026-09-27.md) for contract `ef7cb50ea29a2ab3501dac80d3fa9f05f570294a2fc0107ad0fc5b76cefe3921` only after deploy, mint, fund, wallet, and ledger checks succeeded. The deployment is **operator-signed** and uses valueless test assets. Recheck the sanitized evidence file independently with:

```sh
npm run verify:preprod-launch -- docs/evidence/preprod-launch-2026-09-27.json
```

The read-only verifier checks RPC network identity, the local Compact source and metadata hashes, each transaction's Preprod `SUCCESS` status and expected contract action, plus current funded ledger state. It accepts no seed and submits no transaction. It passed independently for the three setup receipts at blocks 2,723,525/529/537. No Preprod bid, settlement, or claim has been verified; the completed Local Devnet auction belongs to a different contract.

## Contract and evidence boundaries

- The contract has exactly four registered bidder slots in this MVP. The evidence proves this four-slot fixture; it does not prove support for arbitrary participant counts.
- At the marginal price, the contract accepts only an integral pro-rata split. If `quantity × remaining inventory / marginal demand` leaves a remainder, settlement rejects with `NON_INTEGRAL_MARGINAL_ALLOCATION`. It does not distribute leftover units by timestamp or commitment ordering; that fairness extension remains unimplemented.
- Registration slots, commitment hashes, and fixed 5,000 TEST deposits are public. Registration timing can link a slot to wallet activity. After settlement, clearing price, each slot's allocation and refund, and claim flags are public. Since each deposit is fixed, observers can derive slot charges and infer allocated quantities from the clearing price.
- The circuit uses openings as private inputs and stores commitment hashes publicly. The runner does **not** decode raw transaction encodings to check whether max prices, quantities, salts, or recipient keys leak. There is no raw-transaction privacy audit or lifetime bid-size privacy claim.
- There is no bonding curve, secondary trading, LP provisioning, production token, or guarantee of a production launch. Fee sponsorship in the evidence is the Local Devnet genesis operator wallet.
