# Midnight Fair Launch — Judge guide

Public site: https://diveyreadytodive-star.github.io/midnight-fair-launch/

1. In **Explore**, choose a test-token launch whose deployment, mint, and inventory-funding receipts were checked. `Final status not recorded` does not mean the auction settled.
2. In **Judge demo**, change your example maximum price and quantity, seal the bid, then reveal the calculated outcome. This is a **browser calculation**. It does not connect a wallet, generate a Compact proof, submit a new transaction, or move assets.
3. Open the recorded `Unlabeled test token` auction to see the clearing price of 10 TEST, allocations of 300/300/0/0, and refunds of 2000/2000/5000/5000. Its evidence JSON is a **saved record of a past Local Devnet run**.
4. The **Connect wallet** panel prepares a read-only Preprod connection and DUST balance check. **The public site cannot yet submit a bid or claim.** Connecting a wallet alone does not complete an auction action.
5. Use the `KO` button to switch to Korean. The preference persists in this browser.

**Current guarantees and limits:** The Compact contract verifies uniform-price settlement over all registered commitments, up to four. Slots fill in arrival order, so access to a slot remains speed-sensitive. The settlement operator needs every registered bid opening. Non-integral marginal pro-rata allocations are rejected; an auction that remains unsettled past the opening deadline has a cancellation and full-refund path. Per-slot results become public after settlement. Raw transaction encodings have not been audited for private-value leakage.

Only valueless Local Devnet test assets were used. There is no bonding curve, DEX trading, market cap, or production token. Update this guide with receipts if a new Preprod flow is actually verified.
