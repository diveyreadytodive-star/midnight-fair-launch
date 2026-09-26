# Attached Korean pitch draft — factual edits needed before submission

Source inspected read-only: `/Users/blanco/Downloads/attachments (2).zip` (`midnight-fair-launch-pitch-deck-korean-v4.pptx`, 6 slides, and its 3-minute script). Neither file was edited.

1. **Slide 2/3, “봇 우위”, “속도 우위 없음”:** Same-price settlement reduces order advantage *among registered bids*. The contract accepts only four slots and `registerBid` requires the next `registeredBidCount`, so admission still depends on arriving before slots fill. Say “선착순 가격 특혜를 완화” and disclose the four-slot limit.
2. **Slide 3/5, private bid fields:** The circuit accepts maximum price, quantity, recipient and salt as private inputs, but the operator needs every opening for `settle`. After settlement, allocations, refunds and claim flags are public. Raw transaction encodings have not been audited. Do not promise anonymity or that the operator cannot read bids.
3. **Slide 4, Local Devnet evidence:** The 20 receipts, blocks 9380–9493, and 300/300/0/0 allocations describe one original auction contract only. The two later created test tokens have verified deploy/mint/fund receipts but have not settled. Do not merge those records into a single live multi-launch outcome.
4. **Slide 6, public demo:** Public Explore and Create preview are available. Operator-sponsored Create only works with the local test server. Browser bid/claim and Preprod Fair Launch transactions are not yet verified. Do not show a connected wallet as proof of an executed bid.
5. **Slide 6, test count:** `102/102` was a prior fresh-clone result. Public commit `fef27d2` passed a new [fresh-clone build and `npm test` run](evidence/fresh-clone-2026-09-27.md) with **116/116** tests (91 repository/web + 11 Fair Launch + 14 VeilIntent) on 2026-09-27. This proves reproducible build/tests, not a Preprod or browser-wallet transaction. Keep “test assets only” and “Local Devnet” labels until stronger network evidence exists.

The new browser-only judge demo is an explanation of the rules, not an additional chain proof. Do not revise the PPTX or script without the user's separate request.
