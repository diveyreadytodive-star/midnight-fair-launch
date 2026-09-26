# SILENCE Web API contract

The browser adapter lives in `api.js`. The endpoints below are the provisional integration contract for the private-perps server. The UI does not create sample prices, balances, positions, transaction hashes, or successful operation states.

All routes use JSON and same-origin requests with credentials. Amounts are decimal strings in six-decimal demo collateral units, valued at one USD-equivalent unit for display only. Every position uses exactly `1000` valueless test collateral units; this is a fixed public lot, not a user setting. Prices are decimal strings in USD per BTC. Rates are integer basis points (`10_000 = 100%`). Times are ISO 8601 UTC strings. Unknown response fields are ignored by the UI; public routes must still omit per-position private data.

## Public market data

`GET /api/v1/market/BTC-USD`

```json
{
  "market": "BTC-USD",
  "markPrice": "0",
  "oracle": {
    "price": "0",
    "sequence": 0,
    "updatedAt": "2026-09-26T00:00:00.000Z",
    "source": "demo"
  },
  "policy": {
    "fixedCollateralLot": "1000",
    "maxLeverageBps": 30000,
    "maintenanceMarginBps": 1000,
    "estimatedExitCost": "0",
    "profitPayoutCap": "0",
    "riskSlotLiability": "0",
    "availableRiskReserve": "0"
  }
}
```

The example illustrates field types only; zero values are invalid market data and must not be served as a working quote. `markPrice` must correspond to the current accepted oracle value. A demo oracle must be identified as permissioned and test-only. An external reference price is informative and must not be called settlement price unless the contract actually uses it.

`GET /api/v1/market/BTC-USD/candles?interval=15m|1h|4h|1d&limit=120`

```json
{
  "candles": [
    { "time": "2026-09-26T00:00:00.000Z", "open": "0", "high": "0", "low": "0", "close": "0", "volume": "0" }
  ]
}
```

Candles may only represent actual accepted demo-oracle history or a separately identified external market reference. If history is absent, return an empty array. Do not fabricate candle history or volume for the interface.

## Public observer view

`GET /api/v1/observer/market/BTC-USD`

```json
{
  "oracle": { "price": "0", "sequence": 0, "updatedAt": "2026-09-26T00:00:00.000Z", "source": "demo" },
  "policyVersion": "policy-version",
  "occupiedRiskSlots": 0,
  "fixedCollateralLot": "1000"
}
```

This route is unauthenticated and must never include side, exact notional, per-position collateral, entry price, guard width, liquidation level, owner, or a per-position identifier. It must include the fixed public `fixedCollateralLot: "1000"` value so observers can see the collateral rule. Return aggregate fixed risk-slot use, current public oracle data, and public policy version. The latest Local Devnet readback exposes `escrowCoin.value`; the fixed lot is public by design to remove variation in this exposed value. Direction, size, and guard-target privacy remain intended properties and require raw-ledger verification. Transaction timing and oracle changes can also let observers estimate entry-price ranges.

## Authenticated private view

`GET /api/v1/private/positions`

Requires the server's owner-scoped private API session. Return `401` when that session is absent; never fall back to public or demo positions. The page has a separate read-only DApp Connector API v4 wallet panel; a connected wallet address or a browser cookie alone does not authorize this private route. Order entry remains disabled until owner authorization and the Compact proof plus chain-readback path have been independently verified.

```json
{
  "positions": [
    {
      "id": "opaque-private-id",
      "side": "long",
      "notional": "0",
      "collateral": "1000",
      "entryPrice": "0",
      "markPrice": "0",
      "pnl": "0",
      "equity": "0",
      "maintenance": "0",
      "buffer": "0",
      "guardBuffer": "0",
      "status": "open"
    }
  ]
}
```

An authenticated response may include the exact values needed by the owner screen. `collateral` must always equal the public fixed lot `1000`; the risk engine operator can access the other position data. The API, request logs, analytics, and the public observer route must not expose side, notional, guard target, entry price, or owner-specific values. The UI displays a position only from this authenticated response.

## Open request and operation polling

`POST /api/v1/private/positions/open`

Requires the verified owner-scoped API permission/capability. The browser sends the following private intent over the operator API; it is not a chain proof or authorization by itself. A DApp Connector wallet connection, address, or cookie alone does not authorize this request. The request contains no collateral amount: the backend must use exactly the public fixed lot of `1000` test units, reject any attempt to override it, and validate owner authorization, balances, policy bounds, and a valid Compact proof before accepting an open request. Keep the UI open-order feature disabled until owner authorization, Compact proof validation, contract execution, and required chain readback are verified end to end. The current client gate is intentionally closed.

```json
{
  "market": "BTC-USD",
  "side": "long",
  "notional": "0",
  "leverage": "1",
  "guardBuffer": "0"
}
```

Return the real server-created operation identity and current state:

```json
{ "operationId": "opaque-operation-id", "state": "pending" }
```

`GET /api/v1/operations/{operationId}` requires the same verified owner-scoped API permission/capability used for the operation; the opaque operation id alone is not authority. It returns one of `pending`, `proving`, `submitted`, `confirmed`, or `error`. A transaction hash may be returned only for an actually submitted transaction. `confirmed` means a chain receipt has been observed and required contract state has been read back; a proof being generated or a transaction merely being submitted is not confirmation. Error responses should be safe for the user and must not contain witnesses, secrets, or private server diagnostics.

```json
{
  "operationId": "opaque-operation-id",
  "state": "confirmed",
  "txHash": "0x…",
  "explorerUrl": "https://explorer.example/tx/…"
}
```

## Privacy and execution rules

- The browser never sends a wallet seed or operator signing secret.
- Do not mark an operation successful locally. Only render the current state returned by the API.
- Do not show private position values in observer view; switching views clears those values from the DOM and local display state.
- Public responses, server logs, analytics events, and error messages must not contain private position witnesses or exact private values.
- The service risk engine sees private position inputs and may delay or refuse service. Proof delay, oracle gaps, market liquidity, and operator outages can prevent a protective close or still lead to liquidation.
- Current Local Devnet ledger evidence exposes `escrowCoin.value`. Every position therefore uses the same public 1000-unit collateral lot; direction, notional, and guard target are still unverified privacy targets.
- Public transaction timing and oracle prices may reveal an entry-price range. This prototype does not promise complete anonymity.
