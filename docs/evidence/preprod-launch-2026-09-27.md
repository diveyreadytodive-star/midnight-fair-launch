# Fair Launch Preprod setup — 2026-09-27

**What was verified:** a valueless, operator-signed Fair Launch contract was deployed on Midnight **Preprod**, its 600-unit test sale inventory was minted once and funded, and all three transactions were confirmed. This is setup evidence, **not** a user-wallet bid, completed auction, token/refund claim, or permissionless Create.

- Contract address: `ef7cb50ea29a2ab3501dac80d3fa9f05f570294a2fc0107ad0fc5b76cefe3921`
- Deployment block: 2,723,525 at `2026-09-26T21:40:24.001Z` (Preprod indexer time)
- Configured commit deadline: `2026-09-27T21:40:17Z`; open deadline: `2026-09-27T22:40:17Z`

The four admission slots fill by registration arrival order. The 24-hour on-chain commit window remains open after deployment, but the public DApp **does not currently accept bids**. Settlement is **after** the hackathon submission deadline.

| Action | Preprod block | Transaction hash |
| --- | ---: | --- |
| Deploy | 2,723,525 | `21dae2a1475e049550241d32421829c5ceb190c1fe51d1c62d4ed705bc440324` |
| Mint test sale inventory | 2,723,529 | `ab0be5726ba5cd75aa1e98c1c8f8bef06d610db9205dabb11d91e55b60cab4bc` |
| Fund sale inventory | 2,723,537 | `eca93b0323702c869844ab0a538a523c1e2a4f9518c9033b8a2c39f0f7928dbf` |

The guarded deploy runner checked each `SucceedEntirely` receipt, wallet sale-token balance before and after funding, and ledger inventory, reserve, deposit, deadlines, and metadata commitment. It required a fresh positive development-wallet tDUST readback before submitting the first transaction. A **separate read-only verifier** then queried RPC identity, each indexer `SUCCESS` receipt and expected contract action, plus current contract state. Its result was `independently-verified-preprod-launch`, `registeredBidCount=0`, `settled=false`, `cancelled=false`, with funded inventory and the source/metadata hashes matching this repository. Reproduce with `npm run verify:preprod-launch -- docs/evidence/preprod-launch-2026-09-27.json` after `npm run compile`.

[Public evidence JSON](preprod-launch-2026-09-27.json) contains only network, valueless test metadata/config, source hash, contract address/deadlines, funded readback, and receipt references. Protected wallet seed, sale authority secret, storage password, and recovery state remain in ignored `.local` files and were not published. The public Pages site serves a copy for the Preprod card.

**Not demonstrated:** a browser-extension signature, bidder payment mint, sealed bid, operator opening handoff, settlement, refund/token claim, public write service, or raw Preprod transaction privacy audit. The earlier 20-receipt Local Devnet auction remains a separate result and cannot be attributed to this Preprod contract.
