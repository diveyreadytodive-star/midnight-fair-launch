const $ = (selector) => document.querySelector(selector);
const pageViews = [...document.querySelectorAll("[data-page-view]")];
const state = {
  evidence: null,
  replayIndex: 0,
  replayTimer: null,
  homeTimer: null,
  homeStep: 0,
  reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  // Deliberately in-memory only. Never persisted, serialized, logged, or copied into attributes.
  privatePolicy: null,
};

const replayStages = {
  deploy: {
    title: "Contract deployment receipt",
    copy: "The recorded Local Devnet sequence begins with a contract deployment receipt.",
    private: "No buyer ceiling appears in the sanitized evidence JSON.",
  },
  mintTestCoin: {
    title: "Test-token mint receipt",
    copy: "A mint receipt is recorded for the valueless Local Devnet test token.",
    private: "The receipt list does not record a per-step balance or mint amount.",
  },
  createIntent: {
    title: "Buyer intent receipt",
    copy: "The evidence records an intent-creation receipt and an aggregate public escrow amount.",
    private: "The per-intent ceiling, budget, and witness values are omitted from the public evidence.",
  },
  submitQuote: {
    title: "Seller quote receipt",
    copy: "The evidence includes one public quote alongside the quote-submission receipt.",
    private: "The quote does not include the buyer's maximum; exact policy values are omitted.",
  },
  approveQuote: {
    title: "Policy approval receipt",
    copy: "An approval receipt is recorded. The deterministic test prover uses the Compact policy path; no LLM is connected.",
    private: "Witness values and individual check results are not included in this sanitized record.",
  },
  sellerClaimPayout: {
    title: "Seller claim receipt",
    copy: "The evidence records a seller-claim receipt and a separate final wallet readback.",
    private: "The readback does not establish seller asset delivery or an atomic swap.",
  },
  claimBuyerRemainder: {
    title: "Buyer remainder claim receipt",
    copy: "The evidence records a buyer-remainder claim and a separate final wallet readback.",
    private: "The exact policy ceiling is not included in the sanitized public evidence.",
  },
};

const homeReplaySteps = [
  ["Checking private policy", "Recorded Compact approval"],
  ["Releasing seller payment", "Recorded Local Devnet claim"],
  ["Returning buyer remainder", "Recorded Local Devnet claim"],
];

function shortHash(value) {
  const raw = String(value || "");
  return raw.length > 22 ? `${raw.slice(0, 10)}…${raw.slice(-8)}` : raw;
}

function formatUnitPrice(ticks) {
  const price = Number(ticks) / 1_000_000;
  return Number.isFinite(price) ? price.toFixed(2) : "—";
}

function formatInteger(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(amount) : "—";
}

function setPageView() {
  const requested = new URLSearchParams(window.location.search).get("view");
  const activeView = ["evidence", "simulator"].includes(requested) ? requested : "home";
  document.body.dataset.view = activeView;
  for (const view of pageViews) view.hidden = view.dataset.pageView !== activeView;
  for (const link of document.querySelectorAll("[data-nav-view]")) {
    if (link.dataset.navView === activeView) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  document.title = activeView === "evidence" ? "VeilIntent · Recorded evidence" : activeView === "simulator" ? "VeilIntent · Policy simulator" : "VeilIntent · Private payment";
}

function clearPrivatePolicy() {
  state.privatePolicy = null;
  const form = $("#policy-checker");
  form.reset();
  const result = $("#policy-result");
  result.textContent = "";
  result.hidden = true;
  result.classList.remove("is-rejected", "is-error");
}

function stopReplay() {
  if (state.replayTimer !== null) window.clearInterval(state.replayTimer);
  state.replayTimer = null;
  $("#replay-play").textContent = "Play replay";
  $("#replay-play").setAttribute("aria-pressed", "false");
}

function stopHomeReplay() {
  if (state.homeTimer !== null) window.clearTimeout(state.homeTimer);
  state.homeTimer = null;
}

function showReplayStep(index) {
  if (!state.evidence) return;
  const receipts = state.evidence.receipts;
  if (index < 0 || index >= receipts.length) return;
  state.replayIndex = index;
  const receipt = receipts[index];
  const details = replayStages[receipt.stage];
  const record = state.evidence;
  const evidenceText = {
    deploy: `Contract address ${shortHash(record.contractAddress)} and block ${receipt.blockHeight} are recorded.`,
    mintTestCoin: `Mint receipt at block ${receipt.blockHeight}. A per-step mint amount is not recorded; aggregate escrow is ${formatInteger(record.publicEscrowAtoms)} test units.`,
    createIntent: `Intent receipt at block ${receipt.blockHeight}. Aggregate public escrow is ${formatInteger(record.publicEscrowAtoms)} test units; no per-step ledger snapshot is recorded.`,
    submitQuote: `Quote receipt at block ${receipt.blockHeight}. Recorded quote: ${formatInteger(record.publicQuote.quantity)} items × ${formatUnitPrice(record.publicQuote.unitPriceTicks)} test units each = ${formatInteger(record.publicQuote.totalAtoms)} test units; no per-step ledger snapshot is recorded.`,
    approveQuote: `Approval receipt at block ${receipt.blockHeight}. Aggregate final readback marks the intent ${record.finalReadback.intentExecuted ? "executed" : "not executed"}; per-step state and check results are not recorded.`,
    sellerClaimPayout: `Seller claim receipt at block ${receipt.blockHeight}. Separate final wallet readback: ${formatInteger(record.finalReadback.sellerShieldedBalanceAtoms)} test units at the seller; no per-step balance snapshot is recorded.`,
    claimBuyerRemainder: `Buyer remainder receipt at block ${receipt.blockHeight}. Separate final wallet readback: ${formatInteger(record.finalReadback.buyerShieldedBalanceAtoms)} test units at the buyer; no per-step balance snapshot is recorded.`,
  };
  $("#replay-step-index").textContent = `STEP ${String(index + 1).padStart(2, "0")} / ${String(receipts.length).padStart(2, "0")}`;
  $("#replay-step-title").textContent = details.title;
  $("#replay-step-copy").textContent = details.copy;
  $("#replay-public").textContent = evidenceText[receipt.stage] || "Receipt details not recorded.";
  $("#replay-private").textContent = details.private;
  $("#replay-block").textContent = receipt.blockHeight;
  $("#replay-tx").textContent = shortHash(receipt.txId);
  $("#replay-tx").title = receipt.txId;
  $("#replay-tx").setAttribute("aria-label", `Full transaction ID ${receipt.txId}`);
  for (const [stepIndex, button] of [...$("#replay-steps").querySelectorAll("button")].entries()) {
    button.classList.toggle("is-current", stepIndex === index);
    if (stepIndex === index) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  }
  $("#replay-next").disabled = index === receipts.length - 1;
}

function renderReplay(receipts) {
  const list = $("#replay-steps");
  list.replaceChildren();
  receipts.forEach((receipt, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "replay-step-button";
    const number = document.createElement("span");
    number.className = "replay-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const label = document.createElement("strong");
    label.textContent = replayStages[receipt.stage].title;
    const receiptMeta = document.createElement("small");
    receiptMeta.textContent = `RECORDED · BLOCK ${receipt.blockHeight} · TX ${shortHash(receipt.txId)}`;
    receiptMeta.title = `Full transaction ID ${receipt.txId}`;
    button.setAttribute("aria-label", `Step ${index + 1}: ${label.textContent}, recorded, block ${receipt.blockHeight}, transaction ID ${receipt.txId}`);
    button.append(number, label, receiptMeta);
    button.addEventListener("click", () => { stopReplay(); showReplayStep(index); });
    item.append(button);
    list.append(item);
  });
  $("#replay-play").disabled = state.reducedMotion;
  $("#replay-next").disabled = false;
  $("#replay-reset").disabled = false;
  showReplayStep(0);
}

$("#replay-play").addEventListener("click", () => {
  if (!state.evidence || state.reducedMotion) return;
  if (state.replayTimer !== null) { stopReplay(); return; }
  if (state.replayIndex >= state.evidence.receipts.length - 1) return;
  $("#replay-play").textContent = "Pause replay";
  $("#replay-play").setAttribute("aria-pressed", "true");
  state.replayTimer = window.setInterval(() => {
    if (state.replayIndex >= state.evidence.receipts.length - 1) { stopReplay(); return; }
    showReplayStep(state.replayIndex + 1);
  }, 1200);
});

$("#replay-next").addEventListener("click", () => {
  if (!state.evidence) return;
  stopReplay();
  showReplayStep(state.replayIndex + 1);
});

$("#replay-reset").addEventListener("click", () => {
  stopReplay();
  showReplayStep(0);
});

function renderReceipts(receipts) {
  const list = $("#receipt-timeline");
  list.replaceChildren();
  const labels = {
    deploy: "Contract deployed",
    mintTestCoin: "Public test lot minted",
    createIntent: "Buyer created intent",
    submitQuote: "Seller submitted quote",
    approveQuote: "Policy approval receipt",
    sellerClaimPayout: "Seller claim receipt",
    claimBuyerRemainder: "Buyer remainder claim",
  };
  receipts.forEach((receipt, index) => {
    const row = document.createElement("li");
    row.className = "receipt-item";
    const node = document.createElement("span");
    node.className = "receipt-node";
    node.textContent = String(index + 1).padStart(2, "0");
    const stage = document.createElement("strong");
    stage.className = "receipt-stage";
    stage.textContent = labels[receipt.stage] || receipt.stage;
    const block = document.createElement("span");
    block.className = "receipt-block";
    block.textContent = `BLOCK ${receipt.blockHeight}`;
    const hash = document.createElement("span");
    hash.className = "receipt-hash";
    hash.textContent = shortHash(receipt.txId);
    hash.setAttribute("aria-label", `Transaction ID ${receipt.txId}`);
    hash.title = `Transaction ID ${receipt.txId}`;
    row.append(node, stage, block, hash);
    list.append(row);
  });
}

function validateEvidence(record) {
  if (record.kind !== "recorded-static-evidence" || record.network !== "Midnight Local Devnet") throw new Error("Unexpected evidence source.");
  const expectedStages = Object.keys(replayStages);
  if (!Array.isArray(record.receipts) || record.receipts.length !== expectedStages.length || record.receipts.some((receipt, index) => receipt.stage !== expectedStages[index] || !receipt.txId || !receipt.transactionHash || !Number.isInteger(receipt.blockHeight))) throw new Error("Incomplete receipt sequence.");
  if (record.finalReadback.intentExecuted !== true || record.finalReadback.buyerRemainderClaimable !== false) throw new Error("The recorded policy approval is unavailable.");
  const quoteValue = BigInt(record.publicQuote.quantity) * BigInt(record.publicQuote.unitPriceTicks);
  if (quoteValue !== BigInt(record.publicQuote.totalAtoms) * 1_000_000n) throw new Error("The recorded quote arithmetic does not match.");
  if (BigInt(record.finalReadback.sellerShieldedBalanceAtoms) !== BigInt(record.publicQuote.totalAtoms)) throw new Error("The seller readback does not match the quote.");
  if (BigInt(record.publicEscrowAtoms) !== BigInt(record.finalReadback.sellerShieldedBalanceAtoms) + BigInt(record.finalReadback.buyerShieldedBalanceAtoms)) throw new Error("Payment conservation check failed.");
  if (record.blockRange.first !== record.receipts[0].blockHeight || record.blockRange.last !== record.receipts.at(-1).blockHeight) throw new Error("Unexpected block range.");
}

function setHomeResults(record) {
  const quote = record.publicQuote;
  $("#home-escrow").textContent = formatInteger(record.publicEscrowAtoms);
  $("#home-quote").textContent = formatInteger(quote.totalAtoms);
  $("#home-quote-detail").textContent = `${formatInteger(quote.quantity)} items × ${formatUnitPrice(quote.unitPriceTicks)} TEST / item`;
  $("#home-seller-result").textContent = `${formatInteger(record.finalReadback.sellerShieldedBalanceAtoms)} TEST`;
  $("#home-buyer-result").textContent = `${formatInteger(record.finalReadback.buyerShieldedBalanceAtoms)} TEST`;
  $("#home-policy-status").textContent = "READY";
}

function renderEvidence(record) {
  validateEvidence(record);
  state.evidence = record;
  setHomeResults(record);
  $("#boundary-escrow").textContent = `${formatInteger(record.publicEscrowAtoms)} test units`;
  $("#boundary-quote").textContent = `${formatInteger(record.publicQuote.quantity)} items × ${formatUnitPrice(record.publicQuote.unitPriceTicks)} test units each = ${formatInteger(record.publicQuote.totalAtoms)}`;
  $("#agent-order-summary").textContent = `${formatInteger(record.publicQuote.quantity)} items · ${formatUnitPrice(record.publicQuote.unitPriceTicks)} test units each`;
  $("#observer-escrow").textContent = `${formatInteger(record.publicEscrowAtoms)} units`;
  $("#observer-quote").textContent = `${formatInteger(record.publicQuote.totalAtoms)} units`;
  $("#observer-block-range").textContent = `${record.blockRange.first}–${record.blockRange.last}`;
  $("#receipt-range").textContent = `BLOCKS ${record.blockRange.first}–${record.blockRange.last}`;
  $("#observer-intent-state").textContent = record.finalReadback.intentExecuted ? "EXECUTED" : "NOT EXECUTED";
  $("#observer-seller-balance").textContent = `${formatInteger(record.finalReadback.sellerShieldedBalanceAtoms)} units`;
  $("#observer-buyer-balance").textContent = `${formatInteger(record.finalReadback.buyerShieldedBalanceAtoms)} units`;
  $("#change-index").textContent = record.finalReadback.buyerChangeCoinMtIndexBeforeClaim;
  $("#contract-address").textContent = record.contractAddress;
  $("#copy-address").disabled = false;
  $("#execute-replay").disabled = false;
  $("#check-policy").disabled = false;
  renderReplay(record.receipts);
  renderReceipts(record.receipts);
}

async function loadEvidence() {
  try {
    const response = await fetch("./veil-intent-evidence.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Static evidence file is unavailable.");
    renderEvidence(await response.json());
  } catch {
    $("#execute-replay").disabled = true;
    $("#home-policy-status").textContent = "UNAVAILABLE";
    $("#home-policy-status").classList.add("is-unavailable");
    $("#execution-footnote").textContent = "Recorded evidence unavailable · no live fallback";
    $("#check-policy").disabled = true;
    $("#receipt-timeline").replaceChildren();
    const note = document.createElement("li");
    note.className = "loading-row";
    note.textContent = "The static evidence record could not be loaded. No live network fallback is used.";
    $("#receipt-timeline").append(note);
    $("#replay-steps").replaceChildren();
    $("#replay-step-title").textContent = "Evidence unavailable";
    $("#replay-step-copy").textContent = "The local record could not be loaded. No live network fallback is used.";
  }
}

function showHomeReplayStep() {
  const [title, detail] = homeReplaySteps[state.homeStep];
  $("#execution-state-title").textContent = title;
  $("#execution-state-detail").textContent = detail;
  $(".execution-progress span").style.width = `${((state.homeStep + 1) / homeReplaySteps.length) * 100}%`;
  $("#execution-next").hidden = !state.reducedMotion;
  if (state.reducedMotion) return;
  if (state.homeStep === homeReplaySteps.length - 1) {
    state.homeTimer = window.setTimeout(finishHomeReplay, 820);
  } else {
    state.homeTimer = window.setTimeout(() => {
      state.homeStep += 1;
      showHomeReplayStep();
    }, 820);
  }
}

function finishHomeReplay() {
  stopHomeReplay();
  $("#execution-status").hidden = true;
  $("#success-state").hidden = false;
  $(".payment-card").classList.add("is-complete");
  $("#success-title").focus();
}

$("#execute-replay").addEventListener("click", () => {
  if (!state.evidence || $("#execute-replay").disabled) return;
  $("#execute-replay").disabled = true;
  $(".payment-card").classList.add("is-replaying");
  $("#execution-status").hidden = false;
  state.homeStep = 0;
  showHomeReplayStep();
  $("#execution-state-title").focus();
});

$("#execution-next").addEventListener("click", () => {
  if (!state.reducedMotion && $("#execution-next").hidden) return;
  if (state.homeStep >= homeReplaySteps.length - 1) finishHomeReplay();
  else {
    state.homeStep += 1;
    showHomeReplayStep();
  }
});

$("#start-over").addEventListener("click", () => {
  stopHomeReplay();
  $(".payment-card").classList.remove("is-replaying", "is-complete");
  $("#execution-status").hidden = true;
  $("#success-state").hidden = true;
  $("#execute-replay").disabled = !state.evidence;
  $("#execute-replay").focus();
});

$("#policy-checker").addEventListener("submit", (event) => {
  event.preventDefault();
  const result = $("#policy-result");
  result.classList.remove("is-rejected", "is-error");
  result.hidden = false;

  if (!state.evidence) {
    result.classList.add("is-error");
    result.textContent = "Recorded quote unavailable. The local simulation cannot run.";
    return;
  }
  const unitValue = Number($("#max-unit-price").value);
  const budgetValue = Number($("#max-total").value);
  if (!Number.isFinite(unitValue) || !Number.isFinite(budgetValue) || unitValue <= 0 || budgetValue <= 0) {
    state.privatePolicy = null;
    result.classList.add("is-error");
    result.textContent = "Enter both private limits to run the browser-only check.";
    return;
  }

  state.privatePolicy = { unitValue, budgetValue };
  const quoteUnit = Number(state.evidence.publicQuote.unitPriceTicks) / 1_000_000;
  const quoteTotal = Number(state.evidence.publicQuote.totalAtoms);
  const unitPass = quoteUnit <= state.privatePolicy.unitValue;
  const budgetPass = quoteTotal <= state.privatePolicy.budgetValue;
  if (unitPass && budgetPass) {
    result.textContent = "Local simulation: this recorded public quote fits the limits entered in this tab. No proof was generated and no transaction was created.";
  } else {
    result.classList.add("is-rejected");
    result.textContent = `Local simulation rejects the recorded quote because ${!unitPass ? "its unit price exceeds the entered cap" : "its total exceeds the entered budget"}. No proof or transaction was created.`;
  }
});

for (const input of [$("#max-unit-price"), $("#max-total")]) {
  input.addEventListener("input", () => {
    state.privatePolicy = null;
    const result = $("#policy-result");
    result.textContent = "";
    result.hidden = true;
    result.classList.remove("is-rejected", "is-error");
  });
}

$("#copy-address").addEventListener("click", async () => {
  if (!state.evidence) return;
  const button = $("#copy-address");
  try {
    await navigator.clipboard.writeText(state.evidence.contractAddress);
    button.textContent = "Copied";
    window.setTimeout(() => { button.textContent = "Copy"; }, 1400);
  } catch {
    button.textContent = "Select address";
    const range = document.createRange();
    range.selectNodeContents($("#contract-address"));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
});

window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", (event) => {
  state.reducedMotion = event.matches;
  if (state.reducedMotion) {
    stopReplay();
    stopHomeReplay();
    $("#replay-play").disabled = true;
    if (!$("#execution-status").hidden) $("#execution-next").hidden = false;
  } else {
    $("#replay-play").disabled = !state.evidence;
    $("#execution-next").hidden = true;
    if (!$("#execution-status").hidden) showHomeReplayStep();
  }
});

window.addEventListener("pagehide", () => {
  clearPrivatePolicy();
  stopReplay();
  stopHomeReplay();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) return;
  stopReplay();
  stopHomeReplay();
  if (!$("#execution-status").hidden) $("#execution-next").hidden = false;
});

setPageView();
loadEvidence();
