# Fair Launch Local Devnet raw-field probe — 2026-09-27

This is a **targeted direct-encoding scan**, not a complete privacy audit. It does not expand the product's privacy promise to anonymity or permanently hidden bid sizes.

The read-only command `node --import tsx spikes/fair-launch/scripts/audit-recorded-raw.ts` loaded the protected four-bid fixture without printing its secrets. It independently queried the Local Devnet indexer for all **20** [saved transaction IDs](../../spikes/fair-launch/docs/evidence/local-devnet-fair-launch.json), required each returned hash and block height to match the saved receipt, and inspected the public raw transaction hex plus `ContractCall.state` and `ContractCall.zswapState` fields.

| Probe | Observed result |
| --- | --- |
| Exact 32-byte salt of each of four openings | No direct hex match in the 20 raw transactions or structured contract fields |
| Exact 32-byte bidder recipient public key of each slot | No direct hex match in those fields |
| Eight-byte little/big-endian maximum-price pattern in that bidder's registration | Slot 0 matched raw and structured; slot 1 matched structured; slots 2–3 did not match |
| Eight-byte little/big-endian desired-quantity pattern in that bidder's registration | No match for any of the four slots |
| Unrelated deploy/mint control for the same maximum-price patterns | All four price patterns also occurred in unrelated transactions, so a price-pattern match **cannot be attributed to disclosure of that bidder's private input** |

These probes can miss values encoded as fields, limbs, compressed structures, proof inputs, hashes, ciphertext, logs, or other representations. A common eight-byte integer sequence can appear for unrelated reasons, as the control transactions demonstrate. The scan does not prove that the operator, proving service, network observer, or post-settlement reader cannot infer a bid. The operator needs every opening for settlement; after settlement, clearing price, allocation, refund, and claim flags are public. Fixed deposits allow additional inference.

The original 20-transaction Local Devnet runner did not perform this scan; this is a later independent read-only analysis. Do not describe the recorded run itself as a full raw-transaction privacy audit.
