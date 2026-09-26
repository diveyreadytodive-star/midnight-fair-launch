# Preprod test integration — operator-only, unverified writes

These scripts are separate from the completed Local Devnet one-shot runner. They use the protected `.local/preprod-dev-wallet.json` development wallet and valueless Preprod assets. Never pass the Local Devnet genesis seed to them. Their `--execute` paths have **not** been verified by a finalized Preprod Fair Launch transaction.

From the repository root, read-only checks are:

```sh
node --import tsx scripts/check-preprod-wallet.ts
node --import tsx scripts/register-preprod-dust.ts
node --import tsx spikes/fair-launch/scripts/deploy-preprod-demo.ts
```

The first prints a bounded wallet-sync snapshot and clearly marks whether the shielded, unshielded, and DUST parts are complete. It never submits a transaction. The second checks Preprod chain identity, re-queries the two earlier unconfirmed DUST registration identifiers, waits for unshielded sync, and estimates a registration fee only after the SDK finishes DUST sync. Its preflight may take a long time on a newly scanned wallet. The third checks Preprod RPC/indexer, the local proof server, Compact artifacts, and a fixed valueless token configuration without reading the seed or submitting anything.

The registration script's `--execute` mode exists for the development wallet only. It creates a one-shot protected lock/manifest under `.local`, waits for enough generated DUST to pay the registration fee, persists the transaction identifier before submission, and then requires an indexer-confirmed receipt. An ambiguous submission retains its lock and `submission-unconfirmed` state. Never delete the lock, manifest, or earlier attempt files to retry; reconcile them first.

The deployment script's `--execute` mode refuses to start without an indexed DUST registration manifest and an actual nonzero wallet DUST balance. It requires full wallet sync, writes protected recovery before any contract transaction, and checks separate deploy, mint, and inventory-funding receipts plus ledger and wallet readback. It writes only valueless test-token evidence under its protected `.local` run directory. A failure after any submission stays `recovery-required` and must be reconciled manually. The script does **not** add a public Explore card or provide a browser-signed auction.

The live judge requirement remains a separate gate: a compatible user's browser wallet must mint a test payment lot, register a bid, preserve/reveal its opening, and later claim a refund or token with independent receipt and wallet readback. Do not call an operator-created Preprod contract a permissionless browser launch.
