# Independent receipt cross-check

After the escrow spike wrote [sanitized local-chain.json](escrow-local-chain.json), the supervising agent queried the isolated local indexer at `http://127.0.0.1:18088/api/v4/graphql` independently of the spike's SDK harness. The historical harness uses a sibling local checkout and is intentionally not part of this standalone repository.

| Faucet-style transaction identifier | Indexer hash | Confirmed block |
|---|---|---:|
| `0018ae5516f39b75bebf903b29137d6647835c89b35681f997857c412d554b83cf` (deposit) | `7e0608a7cb604061b23add12b56faadf2b2ea774c5adb722aaf76d51541da771` | 239 |
| `00653caa7bc1302545f2fa83fc0d66ebeac676f9898ea2750918758c0bbbc0ccbc` (release) | `c41fab91896c21cf2315ef4e67753d3a04d67dd58f2dd02dd26cdee585ce948b` | 243 |

The read-only query used `transactions(offset:{identifier:"..."}) { hash block { height } }`. This verifies that the two submitted identifiers reached the independent indexer at the recorded heights. It does **not**, by itself, re-prove the wallet balance change, public escrow value, or Compact circuit constraints; those are supported by the spike's harness/readback and must remain separately labeled.
