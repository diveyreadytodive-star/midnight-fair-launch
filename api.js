/**
 * SILENCE web API adapter.
 * The interface is intentionally narrow; see API.md before changing routes.
 * No successful order, price, balance, or chain receipt is synthesized here.
 */
const API_BASE = window.SILENCE_API_BASE || "";

export class ApiError extends Error {
  constructor(message, status = 0, code = "network_error") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      credentials: "include",
      headers: { Accept: "application/json", ...options.headers },
      ...options,
    });
  } catch {
    throw new ApiError("The SILENCE API is unavailable.");
  }

  if (!response.ok) {
    const messages = {
      401: "An owner-scoped SILENCE API session is required to view private positions.",
      403: "This request is not authorized for the current wallet.",
      404: "The requested SILENCE API route is not available yet.",
      503: "The SILENCE service is temporarily unavailable.",
    };
    throw new ApiError(messages[response.status] || `SILENCE API returned ${response.status}.`, response.status, "http_error");
  }

  try {
    return await response.json();
  } catch {
    throw new ApiError("The SILENCE API returned an invalid response.", response.status, "invalid_json");
  }
}

function record(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(`Invalid ${name} response.`, 200, "invalid_shape");
  }
  return value;
}

function list(value, name) {
  if (!Array.isArray(value)) throw new ApiError(`Invalid ${name} response.`, 200, "invalid_shape");
  return value;
}

function decimal(value, name) {
  if (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value)) {
    throw new ApiError(`Invalid ${name} value.`, 200, "invalid_shape");
  }
  return value;
}

function positiveDecimal(value, name) {
  decimal(value, name);
  if (Number(value) <= 0) throw new ApiError(`Invalid ${name} value.`, 200, "invalid_shape");
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new ApiError(`Invalid ${name} value.`, 200, "invalid_shape");
  return value;
}

function validateMarket(value) {
  const market = record(value, "market");
  if (market.market !== "BTC-USD") throw new ApiError("Invalid market response.", 200, "invalid_shape");
  const oracle = record(market.oracle, "oracle");
  const policy = record(market.policy, "policy");
  positiveDecimal(market.markPrice, "mark price");
  positiveDecimal(oracle.price, "oracle price");
  requiredString(oracle.updatedAt, "oracle timestamp");
  if (!Number.isInteger(Number(oracle.sequence)) || Number(oracle.sequence) < 0) {
    throw new ApiError("Invalid oracle sequence.", 200, "invalid_shape");
  }
  if (!["demo", "external"].includes(oracle.source)) throw new ApiError("Invalid oracle source.", 200, "invalid_shape");
  decimal(policy.fixedCollateralLot, "fixed collateral lot");
  if (Number(policy.fixedCollateralLot) !== 1_000) throw new ApiError("Market does not match the fixed public collateral lot.", 200, "policy_mismatch");
  decimal(policy.estimatedExitCost, "exit cost");
  decimal(policy.profitPayoutCap, "profit cap");
  decimal(policy.riskSlotLiability, "risk slot liability");
  decimal(policy.availableRiskReserve, "available reserve");
  if (!Number.isInteger(Number(policy.maxLeverageBps)) || Number(policy.maxLeverageBps) < 10_000) {
    throw new ApiError("Invalid maximum leverage policy.", 200, "invalid_shape");
  }
  if (!Number.isInteger(Number(policy.maintenanceMarginBps))) {
    throw new ApiError("Invalid maintenance margin policy.", 200, "invalid_shape");
  }
  if (Number(policy.maintenanceMarginBps) < 0 || Number(policy.maintenanceMarginBps) > 10_000) {
    throw new ApiError("Invalid maintenance margin policy.", 200, "invalid_shape");
  }
  return market;
}

function validateCandles(value) {
  const body = record(value, "candles");
  return list(body.candles, "candles").map((item) => {
    const candle = record(item, "candle");
    for (const key of ["open", "high", "low", "close"]) positiveDecimal(candle[key], `candle ${key}`);
    decimal(candle.volume, "candle volume");
    if (Number(candle.volume) < 0) throw new ApiError("Invalid candle volume.", 200, "invalid_shape");
    if (typeof candle.time !== "string" && typeof candle.time !== "number") {
      throw new ApiError("Invalid candle time.", 200, "invalid_shape");
    }
    return candle;
  });
}

function validateObserver(value) {
  const body = record(value, "observer");
  const forbiddenKeys = new Set([
    "side", "notional", "collateral", "entryPrice", "guardBuffer", "liquidationPrice",
    "owner", "ownerAddress", "positionId", "positions", "position", "commitment", "commitments",
    "openInterestLong", "openInterestShort", "exactOpenInterest", "privatePositions", "pnl",
    "equity", "maintenance", "buffer", "marginHealth",
  ]);
  const containsForbiddenKey = (value) => {
    if (Array.isArray(value)) return value.some(containsForbiddenKey);
    if (value === null || typeof value !== "object") return false;
    return Object.entries(value).some(([key, nested]) => forbiddenKeys.has(key) || containsForbiddenKey(nested));
  };
  if (containsForbiddenKey(body)) throw new ApiError("Observer API included a private position field.", 200, "privacy_boundary_violation");
  const oracle = record(body.oracle, "observer oracle");
  positiveDecimal(oracle.price, "observer oracle price");
  requiredString(oracle.updatedAt, "observer oracle timestamp");
  if (!Number.isInteger(Number(oracle.sequence)) || Number(oracle.sequence) < 0) throw new ApiError("Invalid observer oracle sequence.", 200, "invalid_shape");
  if (!["demo", "external"].includes(oracle.source)) throw new ApiError("Invalid observer oracle source.", 200, "invalid_shape");
  if (!Number.isInteger(Number(body.occupiedRiskSlots))) throw new ApiError("Invalid observer risk slot count.", 200, "invalid_shape");
  decimal(body.fixedCollateralLot, "observer fixed collateral lot");
  if (Number(body.fixedCollateralLot) !== 1_000) throw new ApiError("Observer market does not match the fixed public collateral lot.", 200, "policy_mismatch");
  requiredString(body.policyVersion, "observer policy version");
  // The UI deliberately ignores unknown fields. Public endpoint responses must
  // not contain private position details; backend privacy checks are required.
  return { oracle, policyVersion: body.policyVersion, occupiedRiskSlots: body.occupiedRiskSlots, fixedCollateralLot: body.fixedCollateralLot };
}

function validatePositions(value) {
  const body = record(value, "private positions");
  return list(body.positions, "private positions").map((item) => {
    const position = record(item, "private position");
    if (position.side !== "long" && position.side !== "short") throw new ApiError("Invalid position side.", 200, "invalid_shape");
    for (const key of ["id", "notional", "collateral", "entryPrice", "markPrice", "pnl", "equity", "maintenance", "buffer", "guardBuffer", "status"]) {
      if (key === "id" || key === "status") requiredString(position[key], `position ${key}`);
      else decimal(position[key], `position ${key}`);
    }
    if (Number(position.collateral) !== 1_000) throw new ApiError("Position does not use the fixed public collateral lot.", 200, "policy_mismatch");
    return position;
  });
}

function validateOperation(value) {
  const operation = record(value, "operation");
  requiredString(operation.operationId, "operation id");
  if (!["pending", "proving", "submitted", "confirmed", "error"].includes(operation.state)) {
    throw new ApiError("Invalid operation state.", 200, "invalid_shape");
  }
  if (operation.txHash !== undefined) requiredString(operation.txHash, "transaction hash");
  if (operation.error !== undefined && typeof operation.error !== "string") {
    throw new ApiError("Invalid operation error.", 200, "invalid_shape");
  }
  return operation;
}

export const silenceApi = {
  async market() {
    return validateMarket(await request("/api/v1/market/BTC-USD"));
  },
  async candles(interval = "1h", limit = 120) {
    const params = new URLSearchParams({ interval, limit: String(limit) });
    return validateCandles(await request(`/api/v1/market/BTC-USD/candles?${params}`));
  },
  async observer() {
    return validateObserver(await request("/api/v1/observer/market/BTC-USD"));
  },
  async positions() {
    return validatePositions(await request("/api/v1/private/positions"));
  },
  async openPosition(order) {
    return validateOperation(await request("/api/v1/private/positions/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(order),
    }));
  },
  async operation(operationId) {
    return validateOperation(await request(`/api/v1/operations/${encodeURIComponent(operationId)}`));
  },
};
