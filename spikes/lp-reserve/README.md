# LP reserve accounting spike

This isolated Compact 0.31.1 spike checks whether a position can be backed by
both a fixed 1,000-unit trader shielded coin and a *separately funded* fixed
500-unit LP shielded coin. It accepts a caller-supplied payout from 0 to 1,500
test units and routes the difference to or from the LP reserve. No price feed,
PnL calculation, market matching, or production authorization is included.

The Compact circuit tracks the actual trader coin and LP reserve coin in
separate qualified shielded ledger cells. Its tests cover missing and malformed
reserve deposits, wrong token color, losing and winning payout examples,
partial reserve change written back as a fresh ledger coin, exhaustion at the
1,500-unit ceiling, and replay. A trader loss change stays in contract custody
until a separate LP claim transaction, so the trader's close does not send a
shielded output to an absent LP wallet. The owner claim needs only the owner's
secret and recipient opening; it does not depend on the LP's secret or recipient
salt. The test token is freely mintable inside this spike and has no value.

## Run

From this directory, with the parent project dependencies available:

```sh
npm test
```

The two-wallet Local Devnet runner is `npm run test:chain`. The verified
diagnostic paths set `SILENCE_LP_RESERVE_CASE=diagnostic-loss-static` or
`SILENCE_LP_RESERVE_CASE=diagnostic-profit-static`; the default all-in-one
`claim` circuit still fails `/check` and must not be mistaken for a working
settlement route. The runner requires
`SILENCE_LOCAL_TEST_SEED` to contain a funded, valueless Local Devnet test seed
with usable DUST. It derives a temporary independent LP shielded key and uses
the genesis account as the shared Local Devnet DUST fee sponsor, avoiding new
tNIGHT transfers and registration. This tests separate shielded receipt and
spend control, with partial wallet independence: the LP and trader keys differ
but their transaction fees share the funded genesis account. It runs separate
loss and profit contracts, never reads developer or Preprod wallet files, and
never starts, resets, or stops the shared stack. Endpoints are restricted to
loopback. Before the first transaction it checks a conservative full-run DUST
buffer. On uncertain failure it preserves test-only seeds, claim secrets,
recipient salts, private state, phase, addresses, and receipts in
`spikes/lp-reserve/.local/recovery/` with directory mode 0700 and file mode
0600. A later run refuses to overwrite an unresolved record.

## Simulator evidence

Compact 0.31.1 compilation succeeded and the Compact simulator suite passed
17/17 cases. It confirms the contract rejects an unfunded reserve, wrong
reserve/trader token colors, incorrect reserve size, and payout above the two
funded coins. It also exercises 0, 800, 1,000, 1,200, and 1,500-unit settlement,
recipient binding, separate LP claims to the LP wallet key, one-shot trader and
LP claims, and a 300-unit remainder represented in the contract ledger after a
1,200-unit payout. A spike-only `withdrawReserveRemainder` spends that new coin
in a later simulator call and delivers it to the LP key. The separate static
profit chain run below also confirmed that later spend.

In the 800-unit case the simulator shows the 200-unit `sendShielded` change as
a contract output and the ledger stores it for the LP claim transaction. That
separate claim produces one shielded output to the committed LP key when the LP
key submits it. In the 1,200-unit case the simulator ledger stores the fresh
300-unit reserve change; the spike's next call spends it through the qualified
ledger field. The original compound claim's simulator result did not predict
its chain proof failure. The static loss/profit circuits were therefore tested
separately with actual receipts and wallet readback below.

## Verified static payout paths on Local Devnet

The original all-in-one `claim` circuit still returns proof-server `/check`
HTTP 400 even for a full 1,000-unit payout after a real 500-unit LP deposit.
An owner-authenticated **single-branch** `diagnosticClaimFull` instead finalized
with the reserve untouched; see [full payout receipt](docs/evidence/diagnostic-full-auth-local-chain.json).

The separate `diagnosticClaimLoss` finalized an 800-unit owner payout at block
2855. A distinct LP shielded key later submitted `claimLpLoss` at block 2859
and read back 200 units. [Loss evidence](docs/evidence/diagnostic-loss-static-local-chain.json).
In another contract, `diagnosticClaimProfit` finalized a 1,200-unit owner
payout at block 2909, storing a new 300-unit reserve change at `mt_index=96`.
The LP later spent that exact coin at block 2913 and read back 300 units.
[Profit evidence](docs/evidence/diagnostic-profit-static-local-chain.json).
These are **test accounting** results: the caller chooses a public payout;
the contract does not calculate PnL or consult an oracle. The public circuit
name and QSCI values reveal the payout regime and amount. The two shielded
keys differ, but the same local genesis DUST key pays fees in the test
process. Neither route proves private economic perp settlement.

## Earlier partial Local Devnet attempts

One chain attempt finalized deployment, a real 500-unit LP reserve deposit, a
1,000-unit trader deposit, and `openPosition`. The subsequent owner claim failed
at the local proof server with HTTP 400. Indexer readback through block 704
found no transaction after `openPosition`; the public contract ledger still
shows an active position with 1,000 trader units and 500 LP units. The original
runner erased its temporary owner secret, LP seed, recipient salts, and wallet
state on failure, so this valueless fixture cannot be settled from the retained
artifacts. It is **not** a successful LP claim or reserve-spendability test.
Sanitized log review found only a generic Proof Server `/check` HTTP 400. A
separate [claim discriminator](../lp-claim-discriminator/README.md) has since
finalized full, partial, change-write, and public-variable-payout claims on
fresh Local Devnet contracts, so none of those features alone explains this
LP circuit failure. A second fresh LP contract also failed `/check` on an
exact **1,000-unit break-even owner claim** after locking a 500-unit reserve;
its protected test-only recovery bundle remains available locally. See
[break-even partial evidence](docs/evidence/break-even-local-chain-partial.json).
The large compound circuit remains the suspected boundary; the exact
prover-level cause is not known. The first contract's committed QSCI indices
are 45 and 43; no claim reached the chain, and no fee error appeared. See
[partial chain evidence](docs/evidence/partial-local-chain.json). The
runner now preserves recovery material with owner-only file permissions and
refuses duplicate runs while the result is pending or uncertain.

## Limits and questions this spike does not answer

- `payoutUnits` is disclosed as an explicit circuit input, and the public
  reserve/loss coin ledger fields expose exact amounts. This spike leaks the
  accounting values; it is not private settlement or validated PnL.
- Its 1,000/500 amounts are raw test units, not the product's planned
  1e9/5e8-atom units.
- The test recipient keys are fixed by commitments, but the circuits disclose
  those keys when sending. Midnight currently does not create recipient
  ciphertext notifications for arbitrary third-party shielded recipients, so
  an output to a non-caller may not appear in that recipient's wallet without
  a separate synchronization mechanism.
- The static loss and profit diagnostics establish one later LP wallet claim
  and one later reserve-change spend on Local Devnet. They do **not** prove
  price-bound PnL, a production LP reserve, Preprod custody, or the original
  compound claim circuit. Old failed contracts remain test-only partial
  fixtures; one has no recovery material and one has protected local recovery.
- LP settlement is an explicit second transaction. The LP secret commitment
  authorizes the claim and the recipient commitment fixes its destination.
  `ownPublicKey()` is prover-controlled; its equality check is only a
  consistency assertion, not caller authentication or proof of wallet delivery.
  The chain test must verify that the LP wallet receives and can spend the
  output.
- `withdrawReserveRemainder` exists only to test that a partial reserve coin
  can be spent after a separate ledger commitment. A real reserve pool should
  keep the remaining coin in its accounting cycle instead of exposing a
  one-off withdrawal circuit.
- This demonstrates test accounting only; it does not establish secure
  liquidation, oracle, keeper, or reusable pooled-reserve design.
