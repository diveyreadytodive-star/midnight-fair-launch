# Two-stage claim feasibility spike

This Compact 0.31.1 simulator spike checks the proposed separation between
ending a trader's exposure and paying out the trader's collateral:

1. `openPosition` escrows one fixed, publicly visible 1,000-unit test-token lot
   and commits the private terms, owner capability, operator capability
   commitment, and owner payout recipient.
2. `operatorClose` checks a separate operator capability and changes state to
   `ClosedUnclaimed`. It has no shielded-coin send and cannot supply a recipient.
3. `ownerClaim` checks the original owner capability and committed position
   witness, then sends the fixed lot to the originally committed shielded key.

Generate the two 32-byte capabilities independently with a cryptographically
secure random generator. Their commitments use separate domain tags.
Possession of the operator
capability permits an early close at any time: `operatorClose` does not check
an oracle, a risk predicate, or a liquidation threshold. This spike also does
not implement PnL, an LP pool, automated transaction submission, wallet
persistence, or an external keeper. It therefore does not claim automatic
settlement or a working perp DEX. The Local Devnet-only test mint must never
be used with real collateral.

`openPosition` receives the operator identity commitment, not the operator's
secret preimage. The Local Devnet harness creates that preimage separately and
passes only the domain-separated commitment with the owner's opening call. It
still runs both roles in one test process, so it does not prove a real browser
or service securely generated, delivered, and protected the preimage. A bad
or unavailable operator commitment can leave funds stuck because this spike
has no owner emergency exit or commitment recovery path.

From the repository root, run `npm --prefix spikes/two-stage-claim test` after
installing the repository dependencies and making Compact 0.31.1 available
through `COMPACTC`, `.tools/compact`, or the version cache. Or run the same
steps individually:

```sh
COMPACTC=/path/to/compactc.bin node spikes/two-stage-claim/scripts/compile.mjs
node --import tsx --test spikes/two-stage-claim/tests/contract.test.ts
```

The shared-stack chain acceptance run is `npm --prefix
spikes/two-stage-claim run test:chain`. It requires an explicitly supplied,
funded valueless Local Devnet seed in `SILENCE_LOCAL_TEST_SEED`, generates a
separate temporary operator seed. It never reads `.local/preprod-*` or uses
the developer's Preprod wallet. The operator's shielded key remains distinct, but
the operator transaction is balanced and submitted by the **same local test
process with access to the owner's DUST secret key**. This is a fee-sponsor
workaround for the isolated chain test; it does not prove that a deployed
operator can run without any owner wallet key. It never resets the shared
stack or sends native NIGHT to the operator.

Before its first transaction, the runner creates a recovery record and wallet
state under the Git-ignored `.local/two-stage-claim/` directory. The directory
uses mode 0700 and the manifest uses mode 0600. The manifest holds the
valueless test seeds, private-state password, position witnesses, contract
address, and transaction progress. A normal rerun refuses to proceed while a
record exists; inspect only its non-secret status with
`SILENCE_TWO_STAGE_RECOVERY_STATUS=1 npm --prefix spikes/two-stage-claim run test:chain`.
Verify pending IDs against the indexer before deciding how to
recover or remove it. Test the permissions and restart refusal without chain
access using `npm --prefix spikes/two-stage-claim run preflight:recovery`.
The runner removes recovery files only after owner claim, wallet balance
readback, public-state checks, and replay checks all pass.

## Partial Local Devnet evidence

An earlier attempt used an independent fee wallet. The contract deployment
finalized at block 316. The owner-to-operator test NIGHT transfer then
finalized at block 439, creating an unregistered 1,000,000,000 raw local
native-token output for the ephemeral operator address. DUST registration
failed because the output had not yet generated enough DUST
(214,942,000,000,000 available; 300,000,000,277,589 required). The operator
seed was deleted at process exit, so that valueless test output is stranded.
No position was opened in that attempt. See the sanitized
[partial chain evidence](docs/evidence/local-chain-partial.json). The current
acceptance path avoids another NIGHT transfer. The sponsored chain test then
finalized `openPosition` at block 570, `operatorClose` at 573, and `ownerClaim`
at 577. Independent indexer lookups matched all three actions to the deployed
contract; the owner wallet received the fixed test lot and the operator
received none. This proves the separate shielded-key and owner-recipient
boundary with shared fee authority. Full receipt identifiers, indexer hashes,
public-state readback, and the precise limits are in
[Local Devnet evidence](docs/evidence/local-chain.json).

## Local Devnet acceptance flow

The simulator tests prove circuit-state and simulated shielded-output behavior.
By themselves they do not prove separate shielded keys, proof generation,
finality, indexed public disclosure, or real shielded balance changes. The
actual chain run exercised this order without resetting the shared node:

| Step | Wallet / action | Required evidence |
| --- | --- | --- |
| 1 | Owner wallet deploys the spike contract, mints the fixed test lot, and calls `openPosition` with its owner capability, the operator's commitment, and a committed recipient | Finalized receipt; public state says active; escrow value is the fixed lot; public raw/state contains no capabilities, terms, salts, or recipient key |
| 2 | Separate operator shielded key submits `operatorClose` with the operator capability; the local harness uses owner DUST fee material | Finalized receipt; public state says inactive + closed-unclaimed + unsettled; escrow value/index unchanged; operator shielded balance remains zero; owner balance remains zero |
| 3 | Operator wallet attempts `ownerClaim`, passing its operator capability in the owner-secret position | Proof/circuit rejection at `NOT_POSITION_OWNER`; no transaction receipt/state change; owner remains unpaid |
| 4 | Owner wallet calls `ownerClaim` with its owner capability and the original terms, salt, and recipient witness | Finalized receipt; state says settled; owner wallet syncs and reads the fixed lot; the outgoing recipient is the originally committed shielded key |
| 5 | Both wallets try replaying their respective actions | Close and claim reject; public state and balances remain unchanged |

For step 3, the harness must challenge the compiled circuit before transaction
submission and explicitly distinguish proof rejection from an accepted but
unfinalized transaction. Never treat a rejected RPC request or a simulator
result as chain evidence. Inspect the indexer's raw transaction and structured
contract action for each finalized step. Do not reset or restart the shared
stack to make this spike run.

This test uses two distinct Local Devnet **shielded keys** with shared fee
authority and a test-only collateral token. The chain runner holds the
operator preimage and owner DUST secret in its temporary process
memory to perform both roles; the separate-witness circuit flow is checked,
but a production handoff from a protected operator service to the opening
client and fee funding without owner key access remain unimplemented. It
still does not demonstrate an oracle, PnL,
liquidation payout, keeper automation, or safe real-value custody.
