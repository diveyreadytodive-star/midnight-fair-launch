# Preprod faucet funding evidence

- Network: Midnight Preprod
- Recipient: `mn_addr_preprod1833n7kmt7aslchlptv9q88auc3tp9pm0nsrds32mr29mxse2f32s2xqhz3`
- Faucet identifier supplied by user: `00b5c652359afce951e42b1fac0489d17f2aa89a079d960bb5377b182e7ba98429`
- Indexer transaction hash: `86c0a6b190d34024330b43d83844d4b65a7479b85a75958ab8d005807d4f7757`
- Confirmed block height: `2707686`
- Native token output to recipient: `5000000000` STAR = `5000` tNIGHT
- `registeredForDustGeneration`: `false` on the output read at verification.

Verification used the public Preprod GraphQL indexer at `https://indexer.preprod.midnight.network/api/v4/graphql`, querying `transactions(offset:{identifier:"00b5c652359afce951e42b1fac0489d17f2aa89a079d960bb5377b182e7ba98429"})` and reading `hash`, `block.height`, and `unshieldedCreatedOutputs { owner tokenType value registeredForDustGeneration }`. The faucet identifier is 66 hex characters and is **not** the 64-character transaction hash. This confirms the on-chain output, not the wallet SDK balance or DUST registration; wallet synchronization timed out during this check. No secret or mnemonic is included here.
