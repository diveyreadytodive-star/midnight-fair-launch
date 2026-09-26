import { ApiError, silenceApi } from "./api.js";
import { midnightWalletAdapter } from "./wallet.js";
import { clearPrivatePositionList, createPrivatePositionReadGuard } from "./private-position-guard.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = {
  market: null,
  candles: [],
  observer: null,
  positions: [],
  privateStatus: "loading",
  view: "trader",
  side: "long",
  operation: null,
  interval: "1h",
  busy: false,
};
const privatePositionReadGuard = createPrivatePositionReadGuard(() => state.view === "trader");

const marketRefreshMs = 12_000;
const privateRefreshMs = 15_000;
const candleRefreshMs = 60_000;
const FIXED_COLLATERAL_LOT = "1000";
// Enable only after wallet authorization, Compact proof, contract execution,
// and independent chain readback have all been verified end to end.
const TRADING_BACKEND_VERIFIED = false;

function escapeText(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function formatUsd(value, digits = 2) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
}

function formatAmount(value, digits = 2) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(amount);
}

function formatPercentBps(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `${(amount / 100).toFixed(2)}%` : "—";
}

function decimalToAtoms(value) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function atomsToDecimal(value) {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function relativeTime(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "Timestamp unavailable";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return `Updated ${seconds}s ago`;
  if (seconds < 3600) return `Updated ${Math.floor(seconds / 60)}m ago`;
  return `Updated ${Math.floor(seconds / 3600)}h ago`;
}

function shorten(value, first = 8, last = 6) {
  return value.length > first + last + 3 ? `${value.slice(0, first)}…${value.slice(-last)}` : value;
}

function setServiceState(kind, message) {
  const ribbon = $("#statusRibbon");
  ribbon.classList.toggle("is-online", kind === "online");
  ribbon.classList.toggle("is-error", kind === "error");
  $("#serviceStatus").textContent = message;
}

function setOracleState(isLive, status, updatedAt = null) {
  const badge = $("#oracleBadge");
  badge.classList.toggle("is-live", isLive);
  $("#oracleAge").textContent = updatedAt ? relativeTime(updatedAt) : (isLive ? "Feed connected" : "Waiting for feed");
  $("#oracleStatus").textContent = status;
}

function renderMarket() {
  const market = state.market;
  const oracle = market?.oracle;
  const hasPrice = Boolean(market && oracle && Number(oracle.price) > 0);
  const isDemoOracle = Boolean(hasPrice && oracle.source === "demo");
  const source = oracle?.source === "external" ? "External reference · not settlement" : "Permissioned demo oracle";

  $("#markPrice").textContent = hasPrice ? formatUsd(market.markPrice, 2) : "—";
  $("#priceSource").textContent = hasPrice ? source : "No oracle data";
  $("#oracleBadge").firstChild.textContent = "";
  $("#oracleBadge").lastChild.textContent = oracle?.source === "external" ? " REFERENCE FEED" : " DEMO ORACLE";
  $("#oracleBadge").setAttribute("aria-label", hasPrice ? `${oracle.source === "demo" ? "Demo oracle" : "External reference"} connected. ${source}.` : "Demo oracle data unavailable.");
  $("#chartSource").textContent = hasPrice ? source : "Awaiting connected oracle";
  $("#chartSequence").textContent = oracle ? `Sequence ${oracle.sequence}` : "Sequence —";
  $("#chartHint").textContent = state.candles.length ? `Oracle candles · ${state.interval}` : "Oracle history only";
  setOracleState(isDemoOracle, isDemoOracle ? "Demo oracle connected · test index" : oracle?.source === "external" ? "External reference · not settlement" : "Oracle status unavailable", oracle?.updatedAt || null);

  if (market?.policy) {
    const maxLeverage = Number(market.policy.maxLeverageBps) / 10_000;
    const leverageInput = $("#leverageInput");
    leverageInput.max = String(maxLeverage);
    if (Number(leverageInput.value) > maxLeverage) leverageInput.value = String(maxLeverage);
    $("#maxLeverageLabel").textContent = `Max ${formatAmount(maxLeverage, 1)}×`;
    $("#leverageOutput").textContent = `${formatAmount(leverageInput.value, 1)}×`;
    const enabled = TRADING_BACKEND_VERIFIED && isDemoOracle && state.privateStatus === "ready" && !state.busy;
    $("#collateralLotValue").textContent = formatAmount(market.policy.fixedCollateralLot, 0);
    $("#leverageInput").disabled = !enabled;
    $("#guardInput").disabled = !enabled;
    $("#longButton").disabled = !enabled;
    $("#shortButton").disabled = !enabled;
    $("#submitOrder").disabled = !enabled;
    $("#submitHelp").textContent = !isDemoOracle
      ? (hasPrice ? "Reference prices cannot authorize an order; a contract-accepted test oracle is required." : "Waiting for a current test oracle and market policy.")
      : !TRADING_BACKEND_VERIFIED
        ? "Orders remain disabled until wallet auth, Compact proof and chain readback are verified."
        : state.privateStatus === "ready"
          ? "Open requests require wallet authorization and a valid Compact proof."
          : "Authenticate a test wallet to enable private orders.";
  } else {
    $("#maxLeverageLabel").textContent = "Policy unavailable";
    $("#leverageOutput").textContent = "—";
    $("#collateralLotValue").textContent = formatAmount(FIXED_COLLATERAL_LOT, 0);
  }
  renderOrderEstimate();
}

function drawCandles() {
  const canvas = $("#priceChart");
  const frame = canvas.parentElement;
  const context = canvas.getContext("2d");
  const rect = frame.getBoundingClientRect();
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.floor(rect.width * ratio);
  canvas.height = Math.floor(rect.height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);

  const candles = state.candles;
  const empty = !candles.length;
  $("#chartEmpty").hidden = !empty;
  canvas.setAttribute("aria-label", empty
    ? "BTC-USD oracle price history. No data is available yet."
    : `BTC-USD oracle price history with ${candles.length} published candles for ${state.interval}.`);
  if (empty) return;

  const values = candles.flatMap((candle) => [Number(candle.low), Number(candle.high)]).filter(Number.isFinite);
  if (!values.length) return;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = Math.max(max - min, max * .001, 1);
  const padTop = 20;
  const padBottom = 26;
  const plotHeight = rect.height - padTop - padBottom;
  const step = rect.width / candles.length;
  const bodyWidth = Math.max(2, Math.min(8, step * .47));
  const y = (price) => padTop + ((max + spread * .06 - price) / (spread * 1.12)) * plotHeight;

  for (let line = 0; line < 4; line += 1) {
    const lineY = padTop + plotHeight * line / 3;
    context.strokeStyle = "rgba(84, 99, 96, .22)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, lineY);
    context.lineTo(rect.width, lineY);
    context.stroke();
  }

  candles.forEach((candle, index) => {
    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    if (![open, high, low, close].every(Number.isFinite)) return;
    const rising = close >= open;
    const color = rising ? "#b7f36b" : "#ff7975";
    const x = step * (index + .5);
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, y(high));
    context.lineTo(x, y(low));
    context.stroke();
    const top = Math.min(y(open), y(close));
    const height = Math.max(1, Math.abs(y(open) - y(close)));
    context.fillRect(x - bodyWidth / 2, top, bodyWidth, height);
  });
}

function renderObserver() {
  const data = state.observer;
  if (!data) {
    $("#observerPrice").textContent = "—";
    $("#observerPriceMeta").textContent = "Observer feed unavailable";
    $("#observerPolicy").textContent = "—";
    $("#observerSlots").textContent = "—";
    $("#observerCollateralLot").textContent = "—";
    return;
  }
  $("#observerPrice").textContent = formatUsd(data.oracle.price, 2);
  $("#observerPriceMeta").textContent = relativeTime(data.oracle.updatedAt);
  $("#observerPolicy").textContent = data.policyVersion;
  $("#observerSlots").textContent = String(data.occupiedRiskSlots);
  $("#observerCollateralLot").textContent = `${formatAmount(data.fixedCollateralLot, 0)} tUSD`;
}

function renderPositions() {
  const title = $("#positionEmptyTitle");
  const copy = $("#positionEmptyCopy");
  const list = $("#positionList");
  const empty = $(".empty-position");
  const note = $("#walletHelp");
  if (state.privateStatus !== "ready" || !state.positions.length) clearPrivatePositionList(list);

  if (state.privateStatus === "loading") {
    empty.hidden = false;
    list.hidden = true;
    title.textContent = "Checking SILENCE private API session";
    copy.textContent = "Position data is requested from the separate private API only.";
    note.textContent = "The read-only wallet connection does not create a SILENCE server session.";
    return;
  }
  if (state.privateStatus === "unauthenticated") {
    empty.hidden = false;
    list.hidden = true;
    title.textContent = "SILENCE private API session unavailable";
    copy.textContent = "The Wallet overview can read your wallet address and DUST data; it does not grant access to private positions.";
    note.textContent = "Wallet read access and the separate SILENCE position service are different connections.";
    return;
  }
  if (state.privateStatus === "unavailable") {
    empty.hidden = false;
    list.hidden = true;
    title.textContent = "Private positions unavailable";
    copy.textContent = "The SILENCE private API did not return the required owner-scoped position response.";
    note.textContent = "This screen does not substitute demo balances or local sample positions.";
    return;
  }
  if (!state.positions.length) {
    empty.hidden = false;
    list.hidden = true;
    title.textContent = "No open private positions";
    copy.textContent = "Confirmed positions from your owner-scoped private API session will appear here.";
    note.textContent = "The operator risk engine can access position data to evaluate protection and liquidation rules.";
    return;
  }

  empty.hidden = true;
  list.hidden = false;
  note.textContent = "Values are returned by the owner-scoped private API. The operator risk engine can see the same position data.";
  list.innerHTML = state.positions.map((position) => {
    const side = position.side;
    const status = escapeText(position.status.replace(/[_-]/g, " "));
    const equity = Number(position.equity);
    const maintenance = Number(position.maintenance);
    const marginRatio = Number.isFinite(equity) && Number.isFinite(maintenance) && equity > 0
      ? Math.min(100, Math.max(0, (equity - maintenance) / equity * 100))
      : 0;
    const healthClass = marginRatio < 15 ? "danger" : marginRatio < 35 ? "warning" : "";
    const buffer = Number(position.buffer);
    const pnl = Number(position.pnl);
    const pnlColor = pnl < 0 ? "negative" : "positive";
    return `<article class="position-card" data-position-id="${escapeText(position.id)}">
      <div class="position-card-head">
        <div class="position-side ${side}"><span aria-hidden="true">${side === "long" ? "↗" : "↘"}</span> BTC · ${side}</div>
        <span class="position-state">${status}</span>
      </div>
      <div class="position-values">
        <div class="position-value"><span>Notional</span><strong>${formatUsd(position.notional)}</strong></div>
        <div class="position-value"><span>Collateral</span><strong>${formatAmount(position.collateral)} tUSD</strong></div>
        <div class="position-value"><span>Entry</span><strong>${formatUsd(position.entryPrice, 2)}</strong></div>
        <div class="position-value"><span>Mark</span><strong>${formatUsd(position.markPrice, 2)}</strong></div>
        <div class="position-value"><span>Unrealized PnL</span><strong class="${pnlColor}">${formatUsd(position.pnl)}</strong></div>
        <div class="position-value"><span>Guard target · unverified</span><strong>${formatAmount(position.guardBuffer)} tUSD</strong></div>
      </div>
      <div class="position-health">
      <div class="position-health-head"><span class="health-label">Owner margin health · ledger privacy unverified</span><strong class="health-buffer">Buffer ${formatUsd(buffer)}</strong></div>
        <div class="health-track" role="meter" aria-label="Owner margin health; public ledger visibility unverified" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(marginRatio)}"><div class="health-fill ${healthClass}" style="width:${marginRatio}%"></div></div>
        <div class="position-health-meta"><span>Equity ${formatAmount(position.equity)} tUSD</span><span>Maintenance ${formatAmount(position.maintenance)} tUSD</span></div>
      </div>
    </article>`;
  }).join("");
}

function clearPrivatePositionView() {
  state.positions = [];
  clearPrivatePositionList($("#positionList"));
}

function renderOrderEstimate() {
  const leverage = Number($("#leverageInput").value);
  const leverageBps = Math.round(Number($("#leverageInput").value) * 10_000);
  let estimate = "—";
  if (state.market?.policy && Number.isInteger(leverageBps)) {
    const notionalAtoms = decimalToAtoms(FIXED_COLLATERAL_LOT) * BigInt(leverageBps) / 10_000n;
    estimate = formatUsd(atomsToDecimal(notionalAtoms), 2);
  }
  $("#notionalEstimate").textContent = estimate;
  if (state.market?.policy) $("#leverageOutput").textContent = `${formatAmount(leverage, 1)}×`;
}

function renderOperation() {
  const panel = $("#operationPanel");
  const op = state.operation;
  panel.classList.toggle("is-error", op?.state === "error");
  $("#operationTx").hidden = true;
  if (!op) {
    $("#operationTitle").textContent = "No active request";
    $("#operationCopy").textContent = "Proof and chain confirmation appear here when a real request is submitted.";
    $$("#operationStepper .step").forEach((step, index) => {
      step.classList.toggle("active", index === 0);
      step.classList.remove("complete");
    });
    return;
  }

  const labels = {
    pending: "Request pending",
    proving: "Generating Compact proof",
    submitted: "Submitted to the network",
    confirmed: "Confirmed and read back",
    error: "Request failed",
  };
  $("#operationTitle").textContent = op.localRequest ? "Sending order request" : labels[op.state];
  $("#operationCopy").textContent = op.localRequest
    ? "Sending a private intent to the owner-scoped operator API. No chain transaction is confirmed."
    : op.state === "error"
    ? op.error || "The API reported that this request failed. No success is assumed."
    : `Operation ${typeof op.operationId === "string" ? shorten(op.operationId) : "—"} · status reported by SILENCE API`;

  const states = ["pending", "proving", "submitted", "confirmed"];
  const terminalIndex = states.indexOf(op.state);
  $$("#operationStepper .step").forEach((step) => {
    const index = states.indexOf(step.dataset.state);
    step.classList.toggle("complete", op.state === "confirmed" || (terminalIndex >= 0 && index < terminalIndex));
    step.classList.toggle("active", op.state !== "error" && index === terminalIndex);
  });
  if (op.state === "confirmed" && op.txHash && /^0x[0-9a-f]{16,}$/i.test(op.txHash)) {
    const txLink = $("#operationTx");
    const url = op.explorerUrl;
    if (typeof url === "string" && url.startsWith("https://")) {
      txLink.href = url;
      txLink.hidden = false;
    }
  }
}

function renderView() {
  const trader = state.view === "trader";
  $("#privatePanel").hidden = !trader;
  $("#orderPanel").hidden = !trader;
  $("#observerPanel").hidden = trader;
  $("#traderViewButton").classList.toggle("selected", trader);
  $("#observerViewButton").classList.toggle("selected", !trader);
  $("#traderViewButton").setAttribute("aria-pressed", String(trader));
  $("#observerViewButton").setAttribute("aria-pressed", String(!trader));
  if (!trader) {
    clearPrivatePositionView();
    renderObserver();
  } else {
    renderPositions();
  }
}

async function refreshMarket() {
  try {
    state.market = await silenceApi.market();
    setServiceState("online", "SILENCE API connected");
    renderMarket();
  } catch (error) {
    state.market = null;
    renderMarket();
    setServiceState("error", error.message || "SILENCE API unavailable");
  }
}

async function refreshCandles() {
  try {
    state.candles = await silenceApi.candles(state.interval, 120);
    $$(".timeframe").forEach((button) => {
      button.disabled = false;
      button.setAttribute("aria-pressed", String(button.dataset.interval === state.interval));
    });
    drawCandles();
    $("#chartHint").textContent = state.candles.length ? `Oracle candles · ${state.interval}` : "No oracle history published";
  } catch {
    state.candles = [];
    $$(".timeframe").forEach((button) => { button.disabled = true; });
    drawCandles();
    $("#chartHint").textContent = "Oracle history only";
  }
}

async function refreshPrivate() {
  if (state.view !== "trader") return;
  return privatePositionReadGuard.run(
    () => silenceApi.positions(),
    (positions) => {
      state.positions = positions;
      state.privateStatus = "ready";
      renderMarket();
      renderPositions();
    },
    (error) => {
      state.positions = [];
      if (error instanceof ApiError && error.status === 401) state.privateStatus = "unauthenticated";
      else state.privateStatus = "unavailable";
      renderMarket();
      renderPositions();
    },
  );
}

async function refreshObserver() {
  if (state.view !== "observer") return;
  try {
    state.observer = await silenceApi.observer();
    renderObserver();
  } catch {
    state.observer = null;
    renderObserver();
  }
}

async function watchOperation(operationId) {
  state.busy = true;
  renderMarket();
  let delay = 1300;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
    try {
      state.operation = await silenceApi.operation(operationId);
      renderOperation();
      if (["confirmed", "error"].includes(state.operation.state)) break;
    } catch (error) {
      state.operation = { operationId, state: "error", error: error.message };
      renderOperation();
      break;
    }
    delay = Math.min(Math.round(delay * 1.25), 8000);
  }
  state.busy = false;
  renderMarket();
  if (state.operation?.state === "confirmed") await refreshPrivate();
}

function showFormError(message) {
  $("#submitHelp").textContent = message;
  $("#submitHelp").classList.add("form-error");
}

function clearFormError() {
  $("#submitHelp").classList.remove("form-error");
}

async function submitOrder(event) {
  event.preventDefault();
  clearFormError();
  if (!TRADING_BACKEND_VERIFIED) {
    showFormError("Orders remain disabled until wallet authentication, Compact proof, and chain readback are verified.");
    return;
  }
  if (!state.market || state.privateStatus !== "ready") {
    showFormError("A current market policy and owner-scoped private API session are required.");
    return;
  }
  const guardBuffer = $("#guardInput").value.trim();
  const leverage = Number($("#leverageInput").value);
  if (!/^(\d+)(\.\d{1,6})?$/.test(guardBuffer) || Number(guardBuffer) < 0) {
    showFormError("Set a private protection buffer with up to six decimals.");
    $("#guardInput").focus();
    return;
  }
  if (!Number.isFinite(leverage) || leverage < 1 || leverage > Number(state.market.policy.maxLeverageBps) / 10_000) {
    showFormError("Leverage is outside the connected market policy.");
    return;
  }
  const leverageBps = BigInt(Math.round(leverage * 10_000));
  const notional = atomsToDecimal(decimalToAtoms(FIXED_COLLATERAL_LOT) * leverageBps / 10_000n);
  state.operation = { state: "pending", localRequest: true };
  state.busy = true;
  renderOperation();
  renderMarket();
  try {
    const operation = await silenceApi.openPosition({
      market: "BTC-USD",
      side: state.side,
      notional,
      leverage: leverage.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""),
      guardBuffer,
    });
    state.operation = operation;
    renderOperation();
    state.busy = false;
    await watchOperation(operation.operationId);
  } catch (error) {
    state.operation = { operationId: "request-rejected", state: "error", error: error.message || "The order request was rejected." };
    state.busy = false;
    renderOperation();
    renderMarket();
  }
}

function selectSide(side) {
  state.side = side;
  $("#longButton").classList.toggle("selected", side === "long");
  $("#shortButton").classList.toggle("selected", side === "short");
  $("#longButton").setAttribute("aria-pressed", String(side === "long"));
  $("#shortButton").setAttribute("aria-pressed", String(side === "short"));
}

function selectView(view) {
  if (state.view !== view) {
    privatePositionReadGuard.invalidate();
    clearPrivatePositionView();
  }
  state.view = view;
  if (view === "trader") {
    state.privateStatus = "loading";
    refreshPrivate();
  } else {
    state.positions = [];
    refreshObserver();
  }
  renderView();
}

function bindEvents() {
  $("#traderViewButton").addEventListener("click", () => selectView("trader"));
  $("#observerViewButton").addEventListener("click", () => selectView("observer"));
  $("#longButton").addEventListener("click", () => selectSide("long"));
  $("#shortButton").addEventListener("click", () => selectSide("short"));
  $("#orderForm").addEventListener("submit", submitOrder);
  $("#leverageInput").addEventListener("input", renderOrderEstimate);
  $("#submitHelp").addEventListener("click", clearFormError);
  $$(".timeframe").forEach((button) => button.addEventListener("click", async () => {
    if (button.disabled) return;
    state.interval = button.dataset.interval;
    await refreshCandles();
    renderMarket();
  }));
  window.addEventListener("resize", drawCandles, { passive: true });
}

async function init() {
  bindEvents();
  renderView();
  renderOperation();
  midnightWalletAdapter.init();
  await Promise.all([refreshMarket(), refreshCandles(), refreshPrivate()]);
  window.setInterval(refreshMarket, marketRefreshMs);
  window.setInterval(refreshCandles, candleRefreshMs);
  window.setInterval(() => {
    if (state.view === "trader") refreshPrivate();
    else refreshObserver();
  }, privateRefreshMs);
  window.setInterval(() => {
    if (state.market?.oracle?.updatedAt) renderMarket();
  }, 5_000);
}

init().catch(() => setServiceState("error", "SILENCE UI failed to initialize"));
