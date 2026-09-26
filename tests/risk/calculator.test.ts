import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASIS_POINTS,
  MAX_I128,
  MAX_U64,
  PRICE_TICKS_PER_USD,
  TOKEN_ATOMS_PER_UNIT,
  assertCanOpenPosition,
  calculatePositionRisk,
  type PositionRiskInput,
  type RiskPolicy,
} from "../../src/risk/calculator.ts";

const atom = TOKEN_ATOMS_PER_UNIT;
const price = PRICE_TICKS_PER_USD;

function policy(overrides: Partial<RiskPolicy> = {}): RiskPolicy {
  return {
    minimumCollateral: atom,
    maximumLeverageBps: 100_000n,
    maintenanceMarginBps: 500n,
    estimatedExitCost: 2n * atom,
    protectiveBuffer: 45n * atom / 2n,
    profitPayoutCap: 50n * atom,
    riskSlotLiability: 50n * atom,
    availableRiskReserve: 50n * atom,
    ...overrides,
  };
}

function position(overrides: Partial<PositionRiskInput> = {}): PositionRiskInput {
  return {
    side: "long",
    collateral: 100n * atom,
    notional: 500n * atom,
    entryPrice: 100n * price,
    markPrice: 90n * price,
    accruedBorrowFee: 3n * atom,
    accruedFundingFee: 0n,
    ...overrides,
  };
}

test("100 collateral / 500 notional: P90 hits the private guard exactly", () => {
  const result = calculatePositionRisk(position(), policy());

  assert.equal(result.pnl, -50n * atom);
  assert.equal(result.currentNotional, 450n * atom);
  assert.equal(result.equity, 47n * atom);
  assert.equal(result.maintenance, 45n * atom / 2n);
  assert.equal(result.buffer, 45n * atom / 2n);
  assert.equal(result.shouldProtectiveClose, true);
  assert.equal(result.isLiquidatable, false);
});

test("fixed 1000 collateral lot preserves the 10x risk example at P90 and P84", () => {
  const lotPolicy = policy({
    estimatedExitCost: 20n * atom,
    protectiveBuffer: 225n * atom,
    profitPayoutCap: 500n * atom,
    riskSlotLiability: 500n * atom,
    availableRiskReserve: 500n * atom,
  });
  const basePosition = position({
    collateral: 1_000n * atom,
    notional: 5_000n * atom,
    accruedBorrowFee: 30n * atom,
  });

  const atP90 = calculatePositionRisk(basePosition, lotPolicy);
  assert.equal(atP90.pnl, -500n * atom);
  assert.equal(atP90.currentNotional, 4_500n * atom);
  assert.equal(atP90.equity, 470n * atom);
  assert.equal(atP90.maintenance, 225n * atom);
  assert.equal(atP90.buffer, 225n * atom);
  assert.equal(atP90.shouldProtectiveClose, true);
  assert.equal(atP90.isLiquidatable, false);

  const atP84 = calculatePositionRisk(
    { ...basePosition, markPrice: 84n * price },
    lotPolicy,
  );
  assert.equal(atP84.pnl, -800n * atom);
  assert.equal(atP84.currentNotional, 4_200n * atom);
  assert.equal(atP84.equity, 170n * atom);
  assert.equal(atP84.maintenance, 210n * atom);
  assert.equal(atP84.buffer, -60n * atom);
  assert.equal(atP84.shouldProtectiveClose, false);
  assert.equal(atP84.isLiquidatable, true);
});

test("a P84 gap is liquidatable and never overlaps the protective-close path", () => {
  const result = calculatePositionRisk(
    position({ markPrice: 84n * price }),
    policy(),
  );

  assert.equal(result.equity, 17n * atom);
  assert.equal(result.currentNotional, 420n * atom);
  assert.equal(result.maintenance, 21n * atom);
  assert.equal(result.isLiquidatable, true);
  assert.equal(result.shouldProtectiveClose, false);
});

test("short PnL reverses the price move sign", () => {
  const losingShort = calculatePositionRisk(
    position({ side: "short", markPrice: 110n * price }),
    policy(),
  );
  const profitableShort = calculatePositionRisk(
    position({ side: "short", markPrice: 84n * price }),
    policy(),
  );

  assert.equal(losingShort.pnl, -50n * atom);
  assert.equal(profitableShort.pnl, 80n * atom);
  assert.equal(profitableShort.traderPayout, 150n * atom);
  assert.equal(profitableShort.profitPaid, 50n * atom);
});

test("signed PnL floors losses away from zero and rounds gains down", () => {
  const smallPosition = position({
    collateral: 10n,
    notional: 10n,
    entryPrice: 3n,
    markPrice: 2n,
    accruedBorrowFee: 0n,
    accruedFundingFee: 0n,
  });
  const smallPolicy = policy({
    minimumCollateral: 1n,
    maximumLeverageBps: BASIS_POINTS,
    maintenanceMarginBps: 1n,
    estimatedExitCost: 0n,
    protectiveBuffer: 0n,
    profitPayoutCap: 10n,
    riskSlotLiability: 10n,
    availableRiskReserve: 10n,
  });

  assert.equal(calculatePositionRisk(smallPosition, smallPolicy).pnl, -4n);
  assert.equal(
    calculatePositionRisk({ ...smallPosition, markPrice: 4n }, smallPolicy).pnl,
    3n,
  );
});

test("maintenance follows current notional; guard can act above maintenance but requires positive payout", () => {
  const exactMaintenance = calculatePositionRisk(
    position({
      collateral: 14_500_000n,
      notional: 100n * atom,
      markPrice: 90n * price,
      accruedBorrowFee: 0n,
    }),
    policy({
      minimumCollateral: atom,
      protectiveBuffer: 100n * atom,
      maximumLeverageBps: 100_000n,
    }),
  );
  const exactExitCostBoundary = calculatePositionRisk(
    position({
      collateral: 16_500_000n,
      notional: 100n * atom,
      markPrice: 90n * price,
      accruedBorrowFee: 0n,
    }),
    policy({
      minimumCollateral: atom,
      protectiveBuffer: 100n * atom,
      maximumLeverageBps: 100_000n,
    }),
  );
  const oneAtomAboveExitCost = calculatePositionRisk(
    position({
      collateral: 16_500_001n,
      notional: 100n * atom,
      markPrice: 90n * price,
      accruedBorrowFee: 0n,
    }),
    policy({
      minimumCollateral: atom,
      protectiveBuffer: 1n,
      maximumLeverageBps: 100_000n,
    }),
  );
  const betweenMaintenanceAndMaintenancePlusExit = calculatePositionRisk(
    position({
      collateral: 15n * atom,
      notional: 100n * atom,
      markPrice: 90n * price,
      accruedBorrowFee: 0n,
    }),
    policy({
      minimumCollateral: atom,
      protectiveBuffer: 0n,
      maximumLeverageBps: 100_000n,
    }),
  );
  const noPositivePayout = calculatePositionRisk(
    position({
      collateral: 12n * atom,
      notional: 100n * atom,
      markPrice: 90n * price,
      accruedBorrowFee: 0n,
    }),
    policy({
      minimumCollateral: atom,
      maintenanceMarginBps: 100n,
      protectiveBuffer: 100n * atom,
      maximumLeverageBps: 100_000n,
    }),
  );

  assert.equal(exactMaintenance.currentNotional, 90n * atom);
  assert.equal(exactMaintenance.maintenance, 45n * atom / 10n);
  assert.equal(exactMaintenance.equity, 45n * atom / 10n);
  assert.equal(exactMaintenance.isLiquidatable, true);
  assert.equal(exactMaintenance.shouldProtectiveClose, false);

  assert.equal(exactExitCostBoundary.equity, 65n * atom / 10n);
  assert.equal(exactExitCostBoundary.maintenance, 45n * atom / 10n);
  assert.equal(exactExitCostBoundary.buffer, 0n);
  assert.equal(exactExitCostBoundary.isLiquidatable, false);
  assert.equal(exactExitCostBoundary.shouldProtectiveClose, true);

  assert.equal(oneAtomAboveExitCost.equity, 65n * atom / 10n + 1n);
  assert.equal(oneAtomAboveExitCost.maintenance, 45n * atom / 10n);
  assert.equal(oneAtomAboveExitCost.buffer, 1n);
  assert.equal(oneAtomAboveExitCost.shouldProtectiveClose, true);

  assert.equal(betweenMaintenanceAndMaintenancePlusExit.equity, 5n * atom);
  assert.equal(betweenMaintenanceAndMaintenancePlusExit.buffer, -15n * atom / 10n);
  assert.equal(betweenMaintenanceAndMaintenancePlusExit.isLiquidatable, false);
  assert.equal(betweenMaintenanceAndMaintenancePlusExit.payoutBeforeCap, 3n * atom);
  assert.equal(betweenMaintenanceAndMaintenancePlusExit.shouldProtectiveClose, true);

  assert.equal(noPositivePayout.equity, 2n * atom);
  assert.equal(noPositivePayout.maintenance, 9n * atom / 10n);
  assert.equal(noPositivePayout.payoutBeforeCap, 0n);
  assert.equal(noPositivePayout.shouldProtectiveClose, false);
});

test("borrow charges reduce buffer while funding credits increase it", () => {
  const guardAt17 = policy({ protectiveBuffer: 39n * atom / 2n });
  const base = calculatePositionRisk(position(), guardAt17);
  const extraBorrow = calculatePositionRisk(
    position({ accruedBorrowFee: 6n * atom }),
    guardAt17,
  );
  const fundingCredit = calculatePositionRisk(
    position({ accruedFundingFee: -2n * atom }),
    guardAt17,
  );

  assert.equal(base.buffer, 45n * atom / 2n);
  assert.equal(base.shouldProtectiveClose, false);
  assert.equal(extraBorrow.equity, 44n * atom);
  assert.equal(extraBorrow.buffer, 39n * atom / 2n);
  assert.equal(extraBorrow.shouldProtectiveClose, true);
  assert.equal(fundingCredit.equity, 49n * atom);
  assert.equal(fundingCredit.buffer, 49n * atom / 2n);
  assert.equal(fundingCredit.shouldProtectiveClose, false);
});

test("profit is capped and the public risk-slot liability stays fixed", () => {
  const highProfit = calculatePositionRisk(
    position({ markPrice: 200n * price, accruedBorrowFee: 0n }),
    policy(),
  );
  const smallerTrade = calculatePositionRisk(
    position({ collateral: 10n * atom, notional: 20n * atom }),
    policy({ minimumCollateral: atom, maximumLeverageBps: 100_000n }),
  );

  assert.equal(highProfit.traderPayout, 150n * atom);
  assert.equal(highProfit.payoutBeforeCap, 598n * atom);
  assert.equal(highProfit.payoutCap, 150n * atom);
  assert.equal(highProfit.profitPaid, 50n * atom);
  assert.equal(highProfit.reservedRiskSlotLiability, 50n * atom);
  assert.equal(smallerTrade.reservedRiskSlotLiability, 50n * atom);
});

test("loss beyond isolated collateral is surfaced as insurance shortfall, not hidden by zero payout", () => {
  const result = calculatePositionRisk(
    position({ side: "short", markPrice: 130n * price }),
    policy(),
  );

  assert.equal(result.equity, -53n * atom);
  assert.equal(result.payoutBeforeCap, -55n * atom);
  assert.equal(result.traderPayout, 0n);
  assert.equal(result.insuranceShortfall, 55n * atom);
  assert.equal(result.reservedRiskSlotLiability, 50n * atom);
});

test("an open position remains monitorable after free reserve for a new slot is depleted", () => {
  const depletedReserve = policy({ availableRiskReserve: 0n });

  assert.throws(
    () => assertCanOpenPosition(position(), depletedReserve),
    /cannot back the fixed risk slot/,
  );
  assert.equal(calculatePositionRisk(position(), depletedReserve).shouldProtectiveClose, true);
});

test("zero prices, negative or zero opening values, excess leverage, and unbacked slots reject", () => {
  const validPosition = position();
  const validPolicy = policy();

  assert.throws(() => calculatePositionRisk({ ...validPosition, entryPrice: 0n }, validPolicy), /entryPrice/);
  assert.throws(() => calculatePositionRisk({ ...validPosition, markPrice: 0n }, validPolicy), /markPrice/);
  assert.throws(() => calculatePositionRisk({ ...validPosition, notional: 0n }, validPolicy), /notional/);
  assert.throws(() => calculatePositionRisk({ ...validPosition, collateral: 0n }, validPolicy), /collateral/);
  assert.throws(() => calculatePositionRisk({ ...validPosition, notional: -1n }, validPolicy), /notional/);
  assert.throws(() => calculatePositionRisk({ ...validPosition, accruedBorrowFee: -1n }, validPolicy), /accruedBorrowFee/);
  assert.throws(
    () => calculatePositionRisk({ ...validPosition, notional: 1_001n * atom }, validPolicy),
    /maximum leverage/,
  );
  assert.throws(
    () => assertCanOpenPosition(validPosition, policy({ availableRiskReserve: 49n * atom })),
    /cannot back the fixed risk slot/,
  );
  assert.throws(
    () => calculatePositionRisk(validPosition, policy({ profitPayoutCap: 51n * atom })),
    /exceeds the fixed risk-slot liability/,
  );
});

test("u64 input bounds and signed intermediate overflow/underflow are rejected", () => {
  assert.throws(
    () => calculatePositionRisk(position({ collateral: MAX_U64 + 1n }), policy()),
    /collateral/,
  );
  assert.throws(
    () => calculatePositionRisk(
      { ...position({ collateral: MAX_U64, notional: MAX_U64 }), entryPrice: 1n, markPrice: MAX_U64 },
      policy({
        minimumCollateral: 1n,
        maximumLeverageBps: BASIS_POINTS,
        estimatedExitCost: 0n,
        protectiveBuffer: 0n,
        profitPayoutCap: 0n,
        riskSlotLiability: 1n,
        availableRiskReserve: 1n,
      }),
    ),
    /notional \* signed price delta/,
  );

  const halfPrice = MAX_U64 / 2n;
  assert.throws(
    () => calculatePositionRisk(
      {
        side: "long",
        collateral: MAX_U64,
        notional: MAX_U64,
        entryPrice: halfPrice,
        markPrice: halfPrice + 1n,
        accruedBorrowFee: 0n,
        accruedFundingFee: 0n,
      },
      policy({
        minimumCollateral: 1n,
        maximumLeverageBps: BASIS_POINTS,
        maintenanceMarginBps: 1n,
        estimatedExitCost: 0n,
        protectiveBuffer: 0n,
        profitPayoutCap: 0n,
        riskSlotLiability: 1n,
        availableRiskReserve: 1n,
      }),
    ),
    /current notional/,
  );

  assert.throws(
    () => calculatePositionRisk(
      {
        side: "short",
        collateral: 1n,
        notional: 3n,
        entryPrice: 1n,
        markPrice: 2n,
        accruedBorrowFee: 0n,
        accruedFundingFee: MAX_I128,
      },
      policy({
        minimumCollateral: 1n,
        maximumLeverageBps: 30_000n,
        maintenanceMarginBps: 1n,
        estimatedExitCost: 0n,
        protectiveBuffer: 0n,
        profitPayoutCap: 0n,
        riskSlotLiability: 1n,
        availableRiskReserve: 1n,
      }),
    ),
    /equity/,
  );
});
