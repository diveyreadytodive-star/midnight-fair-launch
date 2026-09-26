# Preprod development wallet DUST registration — 2026-09-27

Network: Midnight Preprod. Assets: valueless test tNIGHT/tDUST only. The protected development-wallet seed stays in `.local/` and was not copied to this evidence file or the public repository.

- SDK transaction identifier: `0051779b13fdad4e496d82bb614d32d521034caab16db93ad7fe31be5c746daf8e`
- Independently queried indexer transaction hash: `d451aa9f0ffba0efb3fd139e4c41450839ddfb5ea590d9980452975adfde6bb7`
- Confirmed block: **2,722,807**
- The indexer returned one unshielded created output back to the protected development wallet, value `5,000,000,000` STAR = `5,000` tNIGHT, with `registeredForDustGeneration: true`.
- The protected one-shot manifest reports `status: indexed` and retains the operation lock. A separate read-only `--reconcile` run found this identifier indexed and the two older ambiguous identifiers not indexed.

This confirms the **registration transaction and registered tNIGHT output**, not yet a nonzero tDUST wallet balance. A new wallet sync/readback is required before any contract deployment fee claim. It also does not prove a Preprod Fair Launch contract, user-signed browser bid, or actual test-token auction.
