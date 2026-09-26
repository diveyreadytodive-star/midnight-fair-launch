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

The two-wallet Local Devnet runner is `npm run test:chain`. It requires
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
13/13 cases. It confirms the contract rejects an unfunded reserve, wrong
reserve/trader token colors, incorrect reserve size, and payout above the two
funded coins. It also exercises 0, 800, 1,200, and 1,500-unit settlement,
recipient binding, separate LP claims to the LP wallet key, one-shot trader and
LP claims, and a 300-unit remainder represented in the contract ledger after a
1,200-unit payout. A spike-only `withdrawReserveRemainder` spends that new coin
in a later simulator call and delivers it to the LP key; the later chain
transaction must still confirm that it became a committed, spendable coin.

In the 800-unit case the simulator shows the 200-unit `sendShielded` change as
a contract output and the ledger stores it for the LP claim transaction. That
separate claim produces one shielded output to the committed LP key when the LP
key submits it. In the 1,200-unit case the simulator ledger stores the fresh
300-unit reserve change; the spike's next call spends it through the qualified
ledger field. These are simulator observations; none proves the change's
committed `mt_index`, later chain spendability, or actual LP wallet readback.
Those checks did not pass in the partial Local Devnet attempt below.

## Partial Local Devnet attempt

One chain attempt finalized deployment, a real 500-unit LP reserve deposit, a
1,000-unit trader deposit, and `openPosition`. The subsequent owner claim failed
at the local proof server with HTTP 400. Indexer readback through block 704
found no transaction after `openPosition`; the public contract ledger still
shows an active position with 1,000 trader units and 500 LP units. The original
runner erased its temporary owner secret, LP seed, recipient salts, and wallet
state on failure, so this valueless fixture cannot be settled from the retained
artifacts. It is **not** a successful LP claim or reserve-spendability test.
Sanitized log review found only a generic Proof Server `/check` HTTP 400. The
claim circuit's partial `sendShielded`/change-ledger path is the narrowest
candidate, but current logs do not distinguish it from invalid check input or
key/config lookup. The committed QSCI indices are 45 and 43; no claim reached
the chain, and no fee error appeared. See [partial chain evidence](docs/evidence/partial-local-chain.json). The
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
- The Compact simulator cases pass, but the chain acceptance stopped after an
  open position. They do not prove LP claim delivery or reserve remainder
  spendability on a chain, Preprod custody, LP solvency, or reusable reserve
  operations.
- In the partial chain run, the reserve deposit has a committed `mt_index`; the
  profitable partial-spend path has not run on chain. A future accepted run
  must prove the reserve change's `mt_index` and later spend.
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
