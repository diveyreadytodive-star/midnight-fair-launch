# Midnight Fair Launch

A sealed-bid, uniform-price first sale for valueless test tokens on Midnight. The idea is to replace public first-come buying with a short auction: admitted bidders commit to a maximum price and quantity, then the Compact contract checks one clearing price, allocations, refunds, and claims.

**Current network evidence is Local Devnet only. This is not a live token market, investment service, bonding curve, or production launchpad.**

[Public Explore](https://diveyreadytodive-star.github.io/midnight-fair-launch/) · [Browser-only judge demo](https://diveyreadytodive-star.github.io/midnight-fair-launch/judge-demo.html) · [Judge guide (English)](docs/JUDGE-GUIDE.en.md) · [심사위원 안내 (한국어)](docs/JUDGE-GUIDE.ko.md)

## What a judge can do now

| On the public site | Evidence level |
| --- | --- |
| Browse three distinct test launch contracts and their deployment/mint/funding records | Saved Local Devnet receipts and catalog; not a live public-network indexer |
| Inspect one completed four-slot auction: 600 units, clearing price 10 TEST, allocations 300/300/0/0, refunds 2000/2000/5000/5000 | [20 confirmed Local Devnet receipts](spikes/fair-launch/docs/evidence/local-devnet-fair-launch.json), blocks 9380–9493, plus separate wallet readback |
| Change an example bid and reveal uniform-price allocations | **Browser simulation:** no wallet, proof, new transaction, or asset transfer |
| Switch between Korean and English | Browser preference stored locally |
| Open the Preprod wallet panel | Read-only wallet/network/DUST check; **bids and claims are not connected** |
| Enter a token name and auction configuration on Create | Browser preview only on the public site |

The opt-in localhost **operator-sponsored** Create API can deploy a fresh Local Devnet contract, mint its sale token once, fund inventory, and append the card only after receipt and ledger readback. It created `Midnight Moth Test` through the CLI and `Night Bloom Test` through the browser button. An arbitrary user's wallet did **not** sign those launches. Neither of these two later launches has a recorded settlement.

## Midnight implementation

[`fair_launch.compact`](spikes/fair-launch/contracts/fair_launch.compact) fixes a public inventory, reserve price, equal deposit lot, deadlines, and four registration slots. `registerBid` accepts maximum price, quantity, recipient, and salt as private circuit inputs while recording a commitment and escrowed shielded test payment coin. `settle` requires every registered opening and verifies the candidate uniform price, integral marginal allocation, inventory bound, and accounting. Bidders independently call `claimTokens` and `claimRefund`; the seller claims proceeds. `cancelAfterOpeningDeadline` enables full refunds if settlement does not occur in time.

These are **scoped** privacy and fairness properties. Registration slots fill in arrival order, so access to the four available slots remains speed-sensitive. The settlement operator must know every opening. Fixed deposit lots, registration times, commitment hashes, and post-settlement slot allocations/refunds/claim flags are public. A fixed deposit and public clearing price allow some allocation inference. The original runner did **not** audit raw transaction encodings. A [later targeted scan](docs/evidence/fair-launch-targeted-raw-scan.md) found no direct 32-byte salt or recipient-key patterns in 20 re-queried transactions, but cannot prove broader privacy; numeric matches were ambiguous against unrelated controls. Non-integral marginal pro-rata allocation is rejected; the contract does not silently round leftover units. No Sybil prevention, honeypot audit, creator anti-bundling guarantee, or lifetime anonymity is claimed.

The observed Local Devnet commit window was **8 minutes**, not the proposed 30-minute product window. The recorded payment coin, sale token, refunds, seller proceeds, and wallet balances establish one test-asset fixture, not general production liquidity.

## Reproduce the code checks

Node.js 22 or later is required. From a fresh clone:

```sh
npm ci
npm run setup:compiler
npm run compile
npm run typecheck
npm test
```

The root suite compiles/tests inherited SILENCE and VeilIntent research as well as Fair Launch. The current auction, catalog, simulation, wallet-preflight, and locale tests are under `spikes/fair-launch/tests/` and `web/*.test.mjs`. A passing local suite proves code paths, not a public wallet-signed transaction.

To inspect the UI locally without enabling writes:

```sh
python3 -m http.server 3081 --bind 127.0.0.1 --directory web
```

Open `http://127.0.0.1:3081/fair-launch.html`. The catalog and past evidence remain read-only. The Local Devnet Create runner is deliberately separate, opt-in, loopback-only, and uses a valueless operator test seed. See the [Fair Launch spike runbook](spikes/fair-launch/README.md). Do **not** rerun the completed one-shot chain runner in its existing recovery checkout or remove protected recovery state to bypass its guard. Never use a Preprod or real-wallet seed with that Local Devnet harness.

## Submission boundary and next integration gate

The public site is not yet a fully transacting DApp. The next gate is a **public-origin, user-wallet-signed Fair Launch contract call** with confirmed receipt and contract/wallet readback. It requires browser-compatible Compact artifacts and providers, a compatible wallet/prover, a test payment coin, durable bid-opening recovery, and a settlement operator that receives all registered openings. A connected wallet alone does not pass that gate. Preprod DUST registration and an external-network Fair Launch transaction have not yet been verified.

The [pitch fact-check](docs/pitch-fact-check-2026-09-27.md) lists copy that must change before presentation. The supplied PPTX and video are not edited by this repository work. The inherited SILENCE and VeilIntent code remains as research under `contracts/`, `src/`, `spikes/`, and the old web files; it is not Fair Launch completion evidence.
