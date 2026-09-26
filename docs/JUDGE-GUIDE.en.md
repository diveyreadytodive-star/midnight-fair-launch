# Midnight Fair Launch — Judge guide

Public site: https://diveyreadytodive-star.github.io/midnight-fair-launch/

1. In **Explore**, choose a test-token launch whose deployment, mint, and inventory-funding receipts were checked. `Current status not verified` does not mean the auction is live or settled.
2. In **Judge demo**, change your example maximum price and quantity, seal the bid, then reveal the calculated outcome. This is a **browser calculation**. It does not connect a wallet, generate a Compact proof, submit a new transaction, or move assets.
3. Open the recorded `Unlabeled test token` auction to see the clearing price of 10 TEST, allocations of 300/300/0/0, and refunds of 2000/2000/5000/5000. Its evidence JSON is a **saved record of a past Local Devnet run**.
4. Open **Fair Launch Preprod Test** to inspect a different contract's [three confirmed Preprod setup transactions](evidence/preprod-launch-2026-09-27.md). An operator wallet signed deployment, test-token mint, and inventory funding. **No bid, settlement, or claim on this Preprod contract has been verified.** Its current phase is not inferred from the browser clock.
5. The **Connect wallet** panel prepares a read-only Preprod connection and DUST balance check. **The public site cannot yet submit a bid or claim.** Connecting a wallet alone does not complete an auction action.
6. Use the `KO` button to switch to Korean. The preference persists in this browser.

**Current guarantees and limits:** The Compact contract verifies uniform-price settlement over all registered commitments, up to four. Slots fill in arrival order, so access to a slot remains speed-sensitive. The settlement operator needs every registered bid opening. Non-integral marginal pro-rata allocations are rejected; an auction that remains unsettled past the opening deadline has a cancellation and full-refund path. Per-slot results become public after settlement. A limited raw-pattern scan of the Local Devnet receipts is not a full privacy audit; Preprod raw transactions have not been audited.

Only valueless Local Devnet and Preprod test assets were used. There is no bonding curve, DEX trading, market cap, or production token. The Preprod setup was operator-signed and is separate from the completed Local Devnet auction.
