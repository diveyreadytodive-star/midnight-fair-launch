# Browser transaction integration — decision gates

Status: design and source inspection, **not a working browser transaction**. The read-only public wallet panel and the browser-only judge simulation are separate from this path.

## First real transaction

The official [DApp Connector API v4 specification](https://github.com/midnightntwrk/midnight-dapp-connector-api/blob/main/docs/api/_media/SPECIFICATION.md) lets a browser DApp connect to a compatible wallet, get Preprod configuration and shielded public keys, delegate proving, ask the wallet to balance an unsealed transaction, and submit it. It does **not** expose the user's shielded UTXOs or a raw `ShieldedCoinInfo` getter. The official [Leaderboard browser manager](https://github.com/midnightntwrk/midnight-leaderboard/blob/main/leaderboard-ui/src/contexts/BrowserLeaderboardManager.ts) shows the provider bridge for ordinary contract calls, but Fair Launch has a distinct payment-coin requirement.

The smallest Fair Launch experiment is:

1. Connect a real Preprod wallet and require its `getConnectionStatus()` to say `connected`, with matching Preprod network IDs and nonzero tDUST. Obtain the wallet's shielded coin/encryption public keys without exposing secret keys.
2. Join a verified, funded **Preprod Fair Launch contract**, using browser-compatible compiled contract code and ZK assets. The current Local Devnet contract addresses cannot be used on Preprod.
3. Have the same wallet call `mintTestPaymentCoin(5000, randomNonce)` and wait for a successful receipt and wallet balance. Extract the circuit's returned coin record in the DApp call result; do not invent it from an address, balance, log, or hardcoded tuple.
4. Supply that exact coin record and a locally generated `BidOpening` to `registerBid`. Ask the connected wallet to balance/sign the actual unsealed transaction. Wait for a successful receipt and verify that the contract's registered count, slot commitment, and funded flag changed while the wallet's test-payment balance decreased.
5. Compare public raw/structured transaction fields with the opening. Label any privacy claim by the fields actually tested. The wallet's proving implementation sees private proof preimages; the settlement operator must later receive all openings.

Step 3 → 4 is a hypothesis. The current headless Local Devnet runner can read the mint result and register a bid, but **no browser wallet has executed this chain of calls**. A wallet version may also reject shielded-coin balancing into a contract; test the actual installed extension rather than inferring support from SDK types.

[Lace issue #2239](https://github.com/input-output-hk/lace/issues/2239) reports that the older 2.1.0 extension failed to balance shielded-coin spends into a contract even though a headless wallet with a newer SDK could do so. Lace has since [announced version 2.3](https://www.lace.io/blog/lace-2-3-small-refresh-big-changes), but the issue page does not establish whether this exact Fair Launch call now works. Record the tested extension version and the real `registerBid` outcome before treating the bug as fixed or current.

The browser provider needs the version-matched official fetch-ZK-asset and wallet-delegated proof packages. The generated Fair Launch prover keys currently total about **109 MiB**; public asset hosting, cross-origin rules, proof latency, and browser memory must be measured before promising a fast judge path. The repository does not yet include these browser build dependencies or a deployed Preprod contract.

## Settlement and recovery

`settle` proves the result against *every registered opening*, up to four. It cannot be run by a party holding only one bidder's opening when others registered. A public auction therefore needs a bounded way to collect and preserve openings for the settlement operator, with explicit disclosure that the operator learns the private bid fields. The on-chain commitment prevents substitution but does not force the operator to stay online. If an opening is withheld or settlement misses its deadline, `cancelAfterOpeningDeadline` allows cancellation and full refunds. Each bidder still needs their own opening to call `claimRefund`, so loss of that secret can strand a claim even when cancellation works.

A live browser flow must provide account/contract/slot-scoped opening recovery after refresh and browser close, plus an exportable backup before escrow. Merely putting the opening in `localStorage` or sending it to an operator without consent is inadequate. Choose an encrypted local backup and an authenticated/encrypted handoff whose recipient and retention are explicit; then test loss, refresh, operator outage, duplicate settlement, and invalid opening. Do not allow arbitrary public deposits until those paths work.

Four slots fill in transaction arrival order. Uniform-price settlement among admitted bids does not remove the speed contest for admission. A judge demo contract needs a repeatable fresh slot or a separate clearly labeled simulation once slots fill. The current public Pages site has no always-on write/settlement backend; localhost operator Create is not a public service.

An isolated, wallet-created contract with just the judge's own bid could test deploy/mint/fund/register/settle/claim without a public operator service, provided all browser transactions actually work. That would be a useful **single-user integration smoke test**, not evidence that the four-person auction or third-party settlement service is operational. Keep it separate from the multi-user product claim.

## Go/no-go evidence

| Gate | Proof required |
| --- | --- |
| Browser preparation | Real Lace/1AM prompt, matching Preprod IDs, tDUST balance, browser asset fetch and delegated proof capability |
| First write | New user-signed Fair Launch `mintTestPaymentCoin` receipt and wallet readback on Preprod |
| Actual bid | New user-signed `registerBid` receipt, on-chain commitment/funding/count readback, payment wallet debit |
| Auction lifecycle | All openings included in a finalized settlement or a tested cancellation; each bidder independently claims token/refund with wallet readback |
| Public judge availability | The flow works from the deployed HTTPS origin after the developer machine is off, with a new judge wallet and a fresh slot/round |

Do not call the project a public wallet-transacting launchpad until the relevant gate has passed. If only the first write or bid passes, report exactly that and keep the remaining controls disabled.
