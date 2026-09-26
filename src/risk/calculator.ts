/**
 * Pure isolated-margin risk math for the private-perps demo.
 *
 * Units:
 * - `collateral`, entry `notional`, fees, reserves, and payouts are integer
 *   millionths of the demo collateral's USD-equivalent unit.
 *   The demo models one collateral unit as one USD-equivalent unit; it does
 *   not price or prove a real token peg.
 * - `entryPrice` and `markPrice` are integer millionths of USD per BTC.
 * - Prices are ratios in the PnL formula, so their common 1e6 scale cancels.
 * - Rates and leverage use basis points (10_000 = 100%).
 *
 * Rounding:
 * - Signed PnL rounds toward negative infinity. This rounds gains down and
 *   losses farther against the trader, avoiding optimistic fractional atoms.
 * - Maintenance is rounded up. Both are conservative for the pool.
 * - Current position value is rounded up to collateral atoms before applying
 *   maintenance, which can reserve at most one extra atom versus one exact
 *   rational rounding. This avoids understating margin due to truncation.
 * - Fee inputs are already-denominated integer atoms. Any fee-index accrual
 *   must round charges up before constructing this input.
 * - BigInt is only the TypeScript reference implementation. These checked
 *   signed bounds are not a claim that Compact has native signed i128 values;
 *   a Compact port must implement equivalent sign/magnitude constraints with
 *   its supported unsigned arithmetic and prove the same bounds.
 */

export const TOKEN_ATOMS_PER_UNIT = 1_000_000n;
export const PRICE_TICKS_PER_USD = 1_000_000n;
export const BASIS_POINTS = 10_000n;

/** Public input and token amount bounds used by this TypeScript reference. */
export const MAX_U64 = (1n << 64n) - 1n;
export const MAX_U128 = (1n << 128n) - 1n;
export const MAX_I128 = (1n << 127n) - 1n;
export const MIN_I128 = -(1n << 127n);

export type PositionSide = "long" | "short";

export interface PositionRiskInput {
  readonly side: PositionSide;
  /** Positive collateral, in demo collateral atoms. */
  readonly collateral: bigint;
  /** Positive entry USD notional (size × entry price), in collateral atoms. */
  readonly notional: bigint;
  /** Positive BTC/USD price, in micro-USD per BTC. */
  readonly entryPrice: bigint;
  /** Positive BTC/USD oracle mark price, in micro-USD per BTC. */
  readonly markPrice: bigint;
  /** Accrued borrowing charge; non-negative collateral atoms. */
  readonly accruedBorrowFee: bigint;
  /** Net funding charge (positive) or credit (negative), in collateral atoms. */
  readonly accruedFundingFee: bigint;
}

export interface RiskPolicy {
  readonly minimumCollateral: bigint;
  /** Maximum notional / collateral ratio, in basis points. */
  readonly maximumLeverageBps: bigint;
  /** Maintenance margin rate, in basis points of notional. */
  readonly maintenanceMarginBps: bigint;
  /** Estimated cost to close now, in collateral atoms. */
  readonly estimatedExitCost: bigint;
  /** Private guard threshold for equity minus maintenance and exit cost. */
  readonly protectiveBuffer: bigint;
  /** Maximum additional profit paid above original collateral. */
  readonly profitPayoutCap: bigint;
  /** Fixed public liability reserved for each risk slot. */
  readonly riskSlotLiability: bigint;
  /** Free pool reserve available to back the next slot. */
  readonly availableRiskReserve: bigint;
}

export interface PositionRiskResult {
  /** Conservative realized-to-mark PnL in collateral atoms. */
  readonly pnl: bigint;
  /** ceil(entryNotional × markPrice / entryPrice), in collateral atoms. */
  readonly currentNotional: bigint;
  /** Collateral + PnL - borrow charge - net funding charge/credit. */
  readonly equity: bigint;
  readonly maintenance: bigint;
  /** equity - maintenance - estimatedExitCost; may be negative. */
  readonly buffer: bigint;
  readonly isLiquidatable: boolean;
  /** A close may be attempted only while there is positive post-exit-cost margin. */
  readonly shouldProtectiveClose: boolean;
  /** equity - estimatedExitCost before zero-floor and profit cap; may be negative. */
  readonly payoutBeforeCap: bigint;
  /** collateral + profitPayoutCap. */
  readonly payoutCap: bigint;
  /** max(0, payoutBeforeCap), capped by payoutCap. */
  readonly traderPayout: bigint;
  /** Portion of traderPayout above original collateral, in collateral atoms. */
  readonly profitPaid: bigint;
  /** max(0, -payoutBeforeCap); surfaced deficit, not an implemented insurance fund. */
  readonly insuranceShortfall: bigint;
  /** Constant per slot, independent of the private position's size or direction. */
  readonly reservedRiskSlotLiability: bigint;
}

/**
 * Validate that a proposed position fits the demo's opening constraints.
 * Throws RangeError on invalid inputs or when the fixed slot is underfunded.
 */
export function assertCanOpenPosition(
  position: Pick<PositionRiskInput, "collateral" | "notional">,
  policy: RiskPolicy,
): void {
  assertPositionWithinPolicy(position, policy);
  if (policy.availableRiskReserve < policy.riskSlotLiability) {
    throw new RangeError("available reserve cannot back the fixed risk slot");
  }
}

function assertPositionWithinPolicy(
  position: Pick<PositionRiskInput, "collateral" | "notional">,
  policy: RiskPolicy,
): void {
  assertUnsigned("collateral", position.collateral, true);
  assertUnsigned("notional", position.notional, true);
  assertUnsigned("minimumCollateral", policy.minimumCollateral);
  assertUnsigned("maximumLeverageBps", policy.maximumLeverageBps, true);
  assertUnsigned("maintenanceMarginBps", policy.maintenanceMarginBps, true);
  assertUnsigned("estimatedExitCost", policy.estimatedExitCost);
  assertUnsigned("protectiveBuffer", policy.protectiveBuffer);
  assertUnsigned("profitPayoutCap", policy.profitPayoutCap);
  assertUnsigned("riskSlotLiability", policy.riskSlotLiability, true);
  assertUnsigned("availableRiskReserve", policy.availableRiskReserve);

  if (policy.maintenanceMarginBps > BASIS_POINTS) {
    throw new RangeError("maintenanceMarginBps cannot exceed 10000");
  }
  if (position.collateral < policy.minimumCollateral) {
    throw new RangeError("collateral is below minimumCollateral");
  }

  const leverageLeft = checkedI128(
    "notional * 10000",
    position.notional * BASIS_POINTS,
  );
  const leverageRight = checkedI128(
    "collateral * maximumLeverageBps",
    position.collateral * policy.maximumLeverageBps,
  );
  if (leverageLeft > leverageRight) {
    throw new RangeError("notional exceeds maximum leverage for collateral");
  }

  if (policy.profitPayoutCap > policy.riskSlotLiability) {
    throw new RangeError("profitPayoutCap exceeds the fixed risk-slot liability");
  }
}

/** Calculate isolated-margin risk using integer-only conservative arithmetic. */
export function calculatePositionRisk(
  position: PositionRiskInput,
  policy: RiskPolicy,
): PositionRiskResult {
  // Risk monitoring an already-open position must continue even if the free
  // reserve for opening a *new* slot has since fallen below the slot liability.
  assertPositionWithinPolicy(position, policy);
  assertPositivePrice("entryPrice", position.entryPrice);
  assertPositivePrice("markPrice", position.markPrice);
  assertUnsigned("accruedBorrowFee", position.accruedBorrowFee);
  assertSignedI128("accruedFundingFee", position.accruedFundingFee);

  if (position.side !== "long" && position.side !== "short") {
    throw new RangeError("side must be 'long' or 'short'");
  }

  const rawDelta = position.markPrice - position.entryPrice;
  const signedDelta = position.side === "long" ? rawDelta : -rawDelta;
  const pnlNumerator = checkedI128(
    "notional * signed price delta",
    position.notional * signedDelta,
  );
  const pnl = checkedI128(
    "rounded PnL",
    floorDiv(pnlNumerator, position.entryPrice),
  );

  const currentNotionalNumerator = checkedU128(
    "notional * markPrice",
    position.notional * position.markPrice,
  );
  const currentNotional = checkedU64(
    "current notional",
    ceilDiv(currentNotionalNumerator, position.entryPrice),
  );
  const maintenanceNumerator = checkedU128(
    "current notional * maintenanceMarginBps",
    currentNotional * policy.maintenanceMarginBps,
  );
  const maintenance = checkedU64(
    "maintenance",
    ceilDiv(maintenanceNumerator, BASIS_POINTS),
  );

  const equity = checkedI128(
    "equity",
    position.collateral + pnl - position.accruedBorrowFee - position.accruedFundingFee,
  );
  const buffer = checkedI128(
    "buffer",
    equity - maintenance - policy.estimatedExitCost,
  );
  const payoutCap = checkedU64(
    "collateral plus profit payout cap",
    position.collateral + policy.profitPayoutCap,
  );
  const payoutBeforeCap = checkedI128(
    "payout before cap",
    equity - policy.estimatedExitCost,
  );
  const traderPayout = payoutBeforeCap <= 0n
    ? 0n
    : payoutBeforeCap < payoutCap
      ? payoutBeforeCap
      : payoutCap;

  return {
    pnl,
    currentNotional,
    equity,
    maintenance,
    buffer,
    isLiquidatable: equity <= maintenance,
    // These strict bounds keep keeper and liquidation actions disjoint while
    // requiring a positive payout after estimated close cost.
    shouldProtectiveClose:
      equity > maintenance &&
      equity > policy.estimatedExitCost &&
      buffer <= policy.protectiveBuffer,
    payoutBeforeCap,
    payoutCap,
    traderPayout,
    profitPaid: traderPayout > position.collateral
      ? traderPayout - position.collateral
      : 0n,
    // This isolated demo reports losses exceeding collateral. The public fixed
    // risk-slot liability backs profit only and does not cover this deficit.
    insuranceShortfall: payoutBeforeCap < 0n
      ? checkedU64("insurance shortfall", -payoutBeforeCap)
      : 0n,
    reservedRiskSlotLiability: policy.riskSlotLiability,
  };
}

function assertPositivePrice(name: string, value: bigint): void {
  assertUnsigned(name, value, true);
}

function assertUnsigned(name: string, value: bigint, positive = false): void {
  if (typeof value !== "bigint") {
    throw new TypeError(`${name} must be a bigint`);
  }
  if (value < 0n || value > MAX_U64) {
    throw new RangeError(`${name} must be between 0 and MAX_U64`);
  }
  if (positive && value === 0n) {
    throw new RangeError(`${name} must be greater than zero`);
  }
}

function assertSignedI128(name: string, value: bigint): void {
  if (typeof value !== "bigint") {
    throw new TypeError(`${name} must be a bigint`);
  }
  if (value < MIN_I128 || value > MAX_I128) {
    throw new RangeError(`${name} is outside the checked signed range`);
  }
}

function checkedI128(name: string, value: bigint): bigint {
  assertSignedI128(name, value);
  return value;
}

function checkedU64(name: string, value: bigint): bigint {
  if (value < 0n || value > MAX_U64) {
    throw new RangeError(`${name} is outside the checked unsigned range`);
  }
  return value;
}

function checkedU128(name: string, value: bigint): bigint {
  if (value < 0n || value > MAX_U128) {
    throw new RangeError(`${name} is outside the checked unsigned range`);
  }
  return value;
}

/** Mathematical floor division (BigInt's / truncates toward zero). */
function floorDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new RangeError("denominator must be positive");
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder < 0n ? quotient - 1n : quotient;
}

/** Ceiling division for non-negative numerator and positive denominator. */
function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new RangeError("ceilDiv requires a non-negative numerator and positive denominator");
  }
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}
