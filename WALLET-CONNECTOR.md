# Read-only Midnight wallet connector

The browser wallet panel uses the official DApp Connector API v4 shape. It scans `window.midnight`, offers compatible Lace or 1AM providers, and calls the selected provider's `connect("preprod")`. It checks both `getConfiguration()` and `getConnectionStatus()` before showing wallet information; a network mismatch blocks the readout.

After the user connects, this page reads only `getUnshieldedAddress()`, `getDustAddress()`, and `getDustBalance()`. The DUST balance is shown in tDUST and exact SPECK units. DApp Connector API v4 reports balances as `bigint`; the display uses 1 DUST = 10^15 SPECK.

This is a wallet permission for this browser page. It does not create a SILENCE private API session, prove ownership for the operator API, or authorize an order. The adapter does not call `signData`, transfer, transaction balancing/submission, or token balance methods. It does not request a seed phrase or create a shielded coin tuple. The Phase 1 open path must supply a real `ShieldedCoinInfo` from a verified wallet operation before the client can prepare an open; its availability is not assumed here.

## Verification status

The wallet connection flow has not been exercised in a browser with Lace or 1AM. Browser access is blocked while the Mac host is locked, so only static code checks are available in this environment. Provider injection, permission prompts, actual network reporting, DUST units, and wallet method responses remain runtime-unverified. Order entry remains disabled independently of wallet connection until the owner capability and proof/chain path are verified.

## `prepareOpen` integration proposal

The official DApp Connector API v4 has no method that returns a shielded coin tuple or `ShieldedCoinInfo`. It exposes wallet addresses and balances, while transaction methods return serialized transactions; the API specification says DApps do not get direct access to shielded coins or UTXOs. A connected address or DUST balance therefore cannot stand in for the `ShieldedCoinInfo` required by the current Phase 1 contract.

The smallest useful spike is a separate Preprod test flow using exactly the fixed 1,000-unit valueless collateral lot: use only a documented wallet transfer/intent call, wait for its actual transaction result, pass that result through the real `receiveShielded` path, and inspect the typed Compact/indexer result for the required coin information. Record the actual API return shape and chain receipt/readback. If the documented flow does not produce the required `ShieldedCoinInfo`, `prepareOpen` must report `coin-info-unavailable`; do not add an undocumented wallet getter or infer a tuple from balances, addresses, logs, or debug text. This spike has not been run.

Sources: [official DApp Connector API v4 specification](https://github.com/midnightntwrk/midnight-dapp-connector-api/blob/main/docs/api/_media/SPECIFICATION.md) and [v4 release notes](https://github.com/midnightntwrk/midnight-dapp-connector-api/releases).
