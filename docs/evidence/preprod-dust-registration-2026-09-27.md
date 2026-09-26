# Preprod development wallet DUST registration — 2026-09-27

Network: Midnight Preprod. Assets: valueless test tNIGHT/tDUST only. The protected development-wallet seed stays in `.local/` and was not copied to this evidence file or the public repository.

- SDK transaction identifier: `0051779b13fdad4e496d82bb614d32d521034caab16db93ad7fe31be5c746daf8e`
- Independently queried indexer transaction hash: `d451aa9f0ffba0efb3fd139e4c41450839ddfb5ea590d9980452975adfde6bb7`
- Confirmed block: **2,722,807**
- The indexer returned one unshielded created output back to the protected development wallet, value `5,000,000,000` STAR = `5,000` tNIGHT, with `registeredForDustGeneration: true`.
- The protected one-shot manifest reports `status: indexed` and retains the operation lock. A separate read-only `--reconcile` run found this identifier indexed and the two older ambiguous identifiers not indexed.

At the time of this registration record, only the **registration transaction and registered tNIGHT output** were confirmed; a fresh tDUST wallet readback was still required. The later guarded [Preprod deployment](preprod-launch-2026-09-27.md) passed a positive tDUST readback and confirmed three operator-signed contract setup transactions. Neither record proves a user-signed browser bid or a completed Preprod auction.
