# Public browser proof-file delivery — 2026-09-27

The public GitHub Pages origin now serves the Compact `mintTestPaymentCoin` and `registerBid` prover, verifier, and bzkir files. The [manifest](https://diveyreadytodive-star.github.io/midnight-fair-launch/zk/manifest.json) records each file's byte count and SHA-256 and the contract source hash `6730a2f36f90394c6a2b5038bf25d26d249c67c830864f2f0dfa057084b4148b`, which matches the [independently verified Preprod deployment](preprod-launch-2026-09-27.md). The largest file is the 19,476,785-byte bid prover; total transfer is about 25 MB.

Checks performed:

- `npm run verify:public-zk-assets` matched all six staged files against the local manifest and Preprod source hash.
- A separate HTTPS fetch downloaded all six files from the public Pages URL and matched their exact byte counts and SHA-256 hashes.
- From a fresh public in-app browser tab, the optional [proof-file check](https://diveyreadytodive-star.github.io/midnight-fair-launch/proof-asset-check.html) used the official `FetchZkConfigProvider` and reported six matching files and the matching source hash. Its English and Korean success text were both checked. Pages build `7eb15d82a340ac696b4173c564d56b406fb09534` was built before this browser run.

These are **public artifact availability and integrity checks only**. The diagnostic does not connect a wallet, generate a ZK proof, sign a transaction, or submit a bid. The website's write buttons remain disabled. No claim, refund, settlement, or other circuit's proving keys are hosted yet. The earlier local asset check and this public HTTPS check are distinct evidence.
