# LP claim proof discriminator

This spike narrows the Compact 0.31.1 LP owner-claim `/check` rejection with
five circuits compiled from one test-only fixture contract:

1. `claimFullPayout`: send the complete 1,000-unit committed coin, so there is
   no change output.
2. `claimPartialWithoutLedgerWrite`: send 800 units and leave the 200-unit
   shielded change output unrecorded in a ledger cell.
3. `claimPartialWithLedgerWrite`: perform the same 800-unit partial send, then
   pass its 200-unit change coin to `changeCoin.writeCoin`.
4. `claimVariablePayout`: accept a public 800-unit payout input, select the
   partial branch, and store the 200-unit change coin.
5. `claimFullWithReserve`: keep a separate funded 500-unit reserve QSCI while
   sending the trader's full 1,000-unit coin through a single claim circuit.

The simulator tests compare the outcomes. The Local Devnet runner deploys a
fresh instance for each circuit, journals each transaction stage/identifier,
and preserve the valueless genesis seed, owner-only private state, and pending
test witnesses under `spikes/lp-claim-discriminator/.local/recovery/` using
0700/0600 permissions. It refuses to overwrite an unresolved recovery record.
Local Devnet receipts confirm **A, B, C, D and E all finalized** with owner
balance readback: A/E paid 1,000, B/C/D paid 800, C/D stored a 200-unit
contract change with an indexed `mt_index`, and E left its separately funded
500-unit reserve untouched. See [A/B/C evidence](docs/evidence/local-chain.json),
[D evidence](docs/evidence/local-chain-D.json) and
[E evidence](docs/evidence/local-chain-E.json). The earlier two harness
attempts failed before a claim transaction because they passed a raw SDK
public-key object rather than Compact-encoded key bytes; their protected
test-only recovery bundles were preserved and the failures are recorded in
[first](docs/evidence/partial-typed-recipient.json) and
[second](docs/evidence/partial-raw-key.json) records. Neither type error is
the original LP `/check` failure.

Run simulator tests from this directory with `npm test` after installing the
parent project dependencies and making Compact 0.31.1 available.

All five cases use freely mintable local test tokens and raw units. Their
successful chain proofs establish that partial sending, change `writeCoin`,
and a public variable-payout branch plus a second held coin each work in
isolation. The original LP
contract still fails `/check` even for a **full 1,000-unit payout** after a
real reserve deposit; see [break-even partial failure](../lp-reserve/docs/evidence/break-even-local-chain-partial.json).
The owner-authenticated single-branch LP diagnostics also finalized, so the
remaining candidate is the larger **compound `claim` circuit** rather than
these primitives. This spike does not prove
market PnL, LP settlement, or the future spendability of its stored 200-unit
change coin.
