# Browser wallet integration preflight — 2026-09-27

Status: **integration spike only; no user-signed transaction**.

The DApp Connector v4 package declares `getDustBalance()` as `{ cap, balance }`. The public read-only wallet panel previously treated the whole response as a bigint, so a conforming wallet would show DUST as unavailable. It now extracts and validates `balance`; a v4-shaped response is covered by a regression test.

The version-matched official fetch-ZK and DApp Connector proof packages plus the official example's Vite/WASM build path were installed. The failing top-level-await plugin was removed because current Chrome supports native top-level await and the library build failed in its SWC transform. Vite was upgraded to a patched 7.3.6; `npm audit` then reported zero vulnerabilities. The `src/browser/fair-launch-client.ts` spike builds to ignored `.local/browser-build` and is **not** attached to the public site.

A temporary same-origin page served at `127.0.0.1:3083` loaded the bundle in Codex In-app Browser. With a deliberately fake API object, it queried the real Preprod indexer for an all-zero nonexistent address and displayed `Contract was not found on the wallet network`. This establishes module/WASM loading and public query reachability from a browser, not proof generation, wallet balance, signature, transaction submission, or a deployed Fair Launch contract. The temporary page and server were removed/stopped after the check.

Before enabling a public transaction control, the spike needs a confirmed funded Preprod contract, hosted matching ZK artifacts, real unlocked Lace/1AM testing, durable opening and payment-coin recovery, and receipt/readback validation. The Mac was locked during this check, so no extension prompt was tested. The browser client currently exposes only a test-payment mint experiment; it must not be described as bid, settlement, or claim support.

Sources: [DApp Connector API v4](https://github.com/midnightntwrk/midnight-dapp-connector-api/blob/main/docs/api/_media/SPECIFICATION.md), [Midnight official Leaderboard browser provider example](https://github.com/midnightntwrk/midnight-leaderboard/blob/main/leaderboard-ui/src/contexts/BrowserLeaderboardManager.ts).
