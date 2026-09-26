const views = [
  { tab: document.querySelector("#tab-agent"), panel: document.querySelector("#panel-agent"), name: "agent" },
  { tab: document.querySelector("#tab-seller"), panel: document.querySelector("#panel-seller"), name: "seller" },
  { tab: document.querySelector("#tab-observer"), panel: document.querySelector("#panel-observer"), name: "observer" },
];

const state = {
  evidence: null,
  view: "agent",
  // Deliberately in-memory only. Never persisted, serialized, logged, or copied into attributes.
  privatePolicy: null,
};

const $ = (selector) => document.querySelector(selector);

function shortHash(value) {
  const raw = String(value || "");
  return raw.length > 22 ? `${raw.slice(0, 10)}…${raw.slice(-8)}` : raw;
}

function formatUnitPrice(ticks) {
  const price = Number(ticks) / 1_000_000;
  return Number.isFinite(price) ? `$${price.toFixed(2)}` : "—";
}

function formatInteger(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(amount) : "—";
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

function activateView(nextView, { focus = false } = {}) {
  if (nextView !== "agent") clearPrivatePolicy();
  state.view = nextView;
  for (const view of views) {
    const active = view.name === nextView;
    view.tab.classList.toggle("is-active", active);
    view.tab.setAttribute("aria-selected", String(active));
    view.tab.tabIndex = active ? 0 : -1;
    view.panel.hidden = !active;
  }
  if (focus) views.find((view) => view.name === nextView)?.tab.focus();
}

for (const view of views) {
  view.tab.addEventListener("click", () => activateView(view.name));
}

document.querySelector(".view-tabs").addEventListener("keydown", (event) => {
  const currentIndex = views.findIndex((view) => view.name === state.view);
  let nextIndex = currentIndex;
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % views.length;
  else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + views.length) % views.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = views.length - 1;
  else return;
  event.preventDefault();
  activateView(views[nextIndex].name, { focus: true });
});

window.addEventListener("pagehide", clearPrivatePolicy);

function renderEvidence(record) {
  if (record.kind !== "recorded-static-evidence" || record.network !== "Midnight Local Devnet") {
    throw new Error("Evidence record is not the expected static Local Devnet artifact.");
  }
  state.evidence = record;
  $("#recorded-date").textContent = `Checked ${new Date(record.recordedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })}`;
  $("#record-status").textContent = "Seven recorded receipts · static data";
  $("#record-status").classList.add("is-loaded");
  $("#agent-order-summary").textContent = `${formatInteger(record.publicQuote.quantity)} items · ${formatUnitPrice(record.publicQuote.unitPriceTicks)} each`;
  $("#agent-escrow").textContent = `${formatInteger(record.publicEscrowAtoms)} public units`;
  $("#quote-quantity").textContent = formatInteger(record.publicQuote.quantity);
  $("#quote-unit-price").textContent = formatUnitPrice(record.publicQuote.unitPriceTicks);
  $("#quote-total").textContent = formatInteger(record.publicQuote.totalAtoms);
  $("#seller-payout").textContent = formatInteger(record.finalReadback.sellerShieldedBalanceAtoms);
  $("#seller-balance").textContent = `${formatInteger(record.finalReadback.sellerShieldedBalanceAtoms)} units`;
  $("#buyer-balance").textContent = `${formatInteger(record.finalReadback.buyerShieldedBalanceAtoms)} units`;
  $("#observer-escrow").textContent = `${formatInteger(record.publicEscrowAtoms)} units`;
  $("#observer-quote").textContent = `${formatInteger(record.publicQuote.totalAtoms)} units`;
  $("#observer-block-range").textContent = `${record.blockRange.first}–${record.blockRange.last}`;
  $("#observer-seller-balance").textContent = `${formatInteger(record.finalReadback.sellerShieldedBalanceAtoms)} units`;
  $("#observer-buyer-balance").textContent = `${formatInteger(record.finalReadback.buyerShieldedBalanceAtoms)} units`;
  $("#change-index").textContent = record.finalReadback.buyerChangeCoinMtIndexBeforeClaim;
  $("#contract-address").textContent = record.contractAddress;
  $("#copy-address").disabled = false;
  $("#check-policy").disabled = false;
  renderReceipts(record.receipts);
}

function renderReceipts(receipts) {
  const list = $("#receipt-timeline");
  list.replaceChildren();
  $("#receipt-range").textContent = `BLOCKS ${state.evidence.blockRange.first}–${state.evidence.blockRange.last}`;
  const labels = {
    deploy: "Contract deployed",
    mintTestCoin: "Public test lot minted",
    createIntent: "Buyer escrowed 150",
    submitQuote: "Seller submitted quote",
    approveQuote: "Agent policy approved",
    sellerClaimPayout: "Seller claimed 100",
    claimBuyerRemainder: "Buyer claimed 50 change",
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
    hash.textContent = shortHash(receipt.transactionHash);
    hash.setAttribute("aria-label", `Transaction hash ${receipt.transactionHash}`);
    hash.title = `Transaction hash ${receipt.transactionHash}`;
    row.append(node, stage, block, hash);
    list.append(row);
  });
}

async function loadEvidence() {
  try {
    const response = await fetch("./veil-intent-evidence.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Static evidence file is unavailable.");
    renderEvidence(await response.json());
  } catch {
    $("#record-status").textContent = "Recorded evidence unavailable";
    $("#record-status").classList.remove("is-loaded");
    $("#receipt-timeline").replaceChildren();
    const note = document.createElement("li");
    note.className = "loading-row";
    note.textContent = "The static evidence record could not be loaded. No live network fallback is used.";
    $("#receipt-timeline").append(note);
  }
}

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
    result.textContent = `Local simulation: this recorded public quote fits the limits entered in this tab. No proof was generated and no transaction was created.`;
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

loadEvidence();
