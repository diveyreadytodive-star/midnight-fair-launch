const TARGET_NETWORK = "preprod";
const SUPPORTED_API_VERSION = /^4\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SPECKS_PER_DUST = 1_000_000_000_000_000n;

const walletState = {
  providers: [],
  unsupported: [],
  connectedApi: null,
  selectedProvider: null,
  detectedNetwork: "",
  networkMatches: false,
  connecting: false,
  duplicateRdns: false,
};

let initialized = false;

function $(selector) {
  return document.querySelector(selector);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function providerKind(name, rdns, key) {
  const identity = `${name} ${rdns} ${key}`.toLowerCase();
  if (/(?:lace|io\.lace)/.test(identity)) return "Lace";
  if (/(?:\b1am\b|one[ ._-]?am|xyz\.oneam)/.test(identity)) return "1AM";
  return name || "Midnight wallet";
}

function getRegistry() {
  try {
    const registry = window.midnight;
    return record(registry) ? registry : null;
  } catch {
    return null;
  }
}

function getProviderFields(key, candidate) {
  if (!record(candidate)) return null;
  try {
    const name = safeText(candidate.name, "Midnight wallet");
    const rdns = safeText(candidate.rdns);
    const apiVersion = safeText(candidate.apiVersion);
    const connect = candidate.connect;
    return {
      key,
      name,
      rdns,
      apiVersion,
      kind: providerKind(name, rdns, key),
      connect: typeof connect === "function" ? connect.bind(candidate) : null,
    };
  } catch {
    return null;
  }
}

function apiErrorMessage(error) {
  if (record(error) && error.type === "DAppConnectorAPIError") {
    switch (error.code) {
      case "Rejected": return "Wallet connection was cancelled in the wallet.";
      case "PermissionRejected": return "Wallet permission was not granted.";
      case "Disconnected": return "The wallet disconnected. Reconnect it to continue.";
      case "InvalidRequest": return "The wallet rejected this network request.";
      default: return "The wallet could not complete this read-only request.";
    }
  }
  return "The wallet did not complete the read-only request. Check that it is unlocked and try again.";
}

function formatBigInt(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function toNonNegativeBigInt(value) {
  let parsed;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "string" && /^\d+$/.test(value)) parsed = BigInt(value);
  else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) parsed = BigInt(value);
  else throw new TypeError("Wallet returned a balance in an unsupported format.");
  if (parsed < 0n) throw new RangeError("Wallet returned a negative balance.");
  return parsed;
}

function formatDust(specks) {
  const whole = specks / SPECKS_PER_DUST;
  const fraction = (specks % SPECKS_PER_DUST).toString().padStart(15, "0").replace(/0+$/, "");
  const visibleFraction = fraction.slice(0, 8);
  const clipped = fraction.length > 8 ? "…" : "";
  return `${formatBigInt(whole)}${visibleFraction ? `.${visibleFraction}${clipped}` : ""} tDUST`;
}

function setWalletStatus(message, state = "idle") {
  const status = $("#walletConnectionStatus");
  status.textContent = message;
  status.dataset.state = state;
  const button = $("#walletStatus");
  const label = $("#walletLabel");
  if (state === "connected") label.textContent = `${walletState.selectedProvider?.kind || "Wallet"} · read only`;
  else if (state === "network-mismatch") label.textContent = "Wallet network mismatch";
  else if (walletState.providers.length) label.textContent = "Wallet available · read only";
  else if (walletState.unsupported.length) label.textContent = "Wallet version unsupported";
  else label.textContent = "Connect test wallet";
  button.classList.toggle("is-connected", state === "connected");
  button.classList.toggle("is-mismatch", state === "network-mismatch");
}

function setWalletError(message = "") {
  const error = $("#walletConnectionError");
  error.textContent = message;
  error.hidden = !message;
}

function setDetailsVisible(visible) {
  $("#walletReadout").hidden = !visible;
  $("#refreshWalletData").hidden = !visible;
  $("#refreshWalletData").disabled = !visible || !walletState.networkMatches;
  $("#clearWalletView").hidden = !visible;
}

function renderProviderOptions() {
  const select = $("#walletProviderSelect");
  select.replaceChildren();
  walletState.providers.forEach((provider, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${provider.kind} · ${provider.name} · API ${provider.apiVersion}`;
    select.append(option);
  });
  select.hidden = walletState.providers.length < 2;
  $("#walletProviderLabel").hidden = walletState.providers.length < 2;
  const button = $("#connectWalletButton");
  button.disabled = walletState.connecting || Boolean(walletState.connectedApi);
  button.textContent = walletState.providers.length > 1
    ? "Connect selected wallet"
    : walletState.providers.length === 1
      ? `Connect ${walletState.providers[0].kind}`
      : "Scan again";
}

function walletKindWarnings() {
  const unsupported = walletState.unsupported.length
    ? ` Found ${walletState.unsupported.length} wallet provider${walletState.unsupported.length === 1 ? "" : "s"} without a supported API v4 release.`
    : "";
  const duplicate = walletState.duplicateRdns
    ? " Multiple entries share a wallet identity; verify your selection in the wallet extension."
    : "";
  return `${unsupported}${duplicate}`;
}

function scanWallets() {
  const registry = getRegistry();
  const providers = [];
  const unsupported = [];
  if (registry) {
    for (const [key, candidate] of Object.entries(registry)) {
      const fields = getProviderFields(key, candidate);
      if (!fields) continue;
      if (SUPPORTED_API_VERSION.test(fields.apiVersion) && fields.connect) providers.push(fields);
      else unsupported.push(fields);
    }
  }
  const rdns = providers.map((provider) => provider.rdns).filter(Boolean);
  walletState.duplicateRdns = new Set(rdns).size < rdns.length;
  walletState.providers = providers;
  walletState.unsupported = unsupported;
  renderProviderOptions();

  if (walletState.connectedApi) {
    const message = walletState.networkMatches
      ? `${walletState.selectedProvider.kind} is connected to Preprod. Wallet data below is read-only.${walletKindWarnings()}`
      : `Wallet is connected to ${walletState.detectedNetwork || "an unknown network"}; this page requires Preprod.${walletKindWarnings()}`;
    setWalletStatus(message, walletState.networkMatches ? "connected" : "network-mismatch");
    return;
  }
  if (!providers.length) {
    const message = registry
      ? `No compatible DApp Connector API v4 wallet was found.${walletKindWarnings()}`
      : "No Midnight wallet is available in this browser. Install or enable a Preprod-compatible Lace or 1AM wallet, then scan again.";
    setWalletStatus(message, unsupported.length ? "unsupported" : "unavailable");
    return;
  }
  setWalletStatus(`${providers.length} compatible wallet${providers.length === 1 ? "" : "s"} found. Connecting requests wallet permission; no signing or transaction is requested.${walletKindWarnings()}`, "available");
}

function networkIdFrom(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return "";
}

async function checkConnectedNetwork(api) {
  if (typeof api.getConfiguration !== "function" || typeof api.getConnectionStatus !== "function") {
    throw new Error("Wallet API v4 does not expose required network status methods.");
  }
  const [configuration, status] = await Promise.all([
    api.getConfiguration(),
    api.getConnectionStatus(),
  ]);
  const configNetwork = record(configuration) ? networkIdFrom(configuration.networkId) : "";
  const statusNetwork = record(status) ? networkIdFrom(status.networkId) : "";
  if (configNetwork && statusNetwork && configNetwork.toLowerCase() !== statusNetwork.toLowerCase()) {
    return { networkId: `${statusNetwork} / ${configNetwork}`, matches: false };
  }
  const actual = statusNetwork || configNetwork;
  return { networkId: actual || "Unknown", matches: actual.toLowerCase() === TARGET_NETWORK };
}

function readAddress(response, property, label) {
  const address = record(response) ? response[property] : null;
  if (typeof address !== "string" || !address.trim()) throw new TypeError(`${label} was not returned by the wallet.`);
  return address;
}

function showReadError(element, label) {
  element.textContent = `${label} unavailable`;
}

async function refreshWalletData() {
  const api = walletState.connectedApi;
  if (!api || !walletState.networkMatches) return;
  const refreshButton = $("#refreshWalletData");
  refreshButton.disabled = true;
  refreshButton.textContent = "Reading wallet data…";
  setWalletError("");

  const read = async (method) => {
    if (typeof api[method] !== "function") throw new TypeError(`Wallet does not implement ${method}.`);
    return api[method]();
  };
  const [unshieldedAddress, dustAddress, dustBalance] = await Promise.allSettled([
    read("getUnshieldedAddress"),
    read("getDustAddress"),
    read("getDustBalance"),
  ]);
  const issues = [];

  const unshieldedAddressElement = $("#connectedUnshieldedAddress");
  if (unshieldedAddress.status === "fulfilled") {
    try { unshieldedAddressElement.textContent = readAddress(unshieldedAddress.value, "unshieldedAddress", "Unshielded address"); }
    catch { showReadError(unshieldedAddressElement, "Unshielded address"); issues.push("Unshielded address permission or response unavailable."); }
  } else {
    showReadError(unshieldedAddressElement, "Unshielded address");
    issues.push("Unshielded address permission or response unavailable.");
  }

  const dustAddressElement = $("#connectedDustAddress");
  if (dustAddress.status === "fulfilled") {
    try { dustAddressElement.textContent = readAddress(dustAddress.value, "dustAddress", "DUST address"); }
    catch { showReadError(dustAddressElement, "DUST address"); issues.push("DUST address permission or response unavailable."); }
  } else {
    showReadError(dustAddressElement, "DUST address");
    issues.push("DUST address permission or response unavailable.");
  }

  if (dustBalance.status === "fulfilled") {
    try {
      const specks = toNonNegativeBigInt(dustBalance.value);
      $("#connectedWalletDust").textContent = formatDust(specks);
      $("#connectedWalletDustRaw").textContent = `${formatBigInt(specks)} SPECK`;
    } catch {
      $("#connectedWalletDust").textContent = "Balance unavailable";
      $("#connectedWalletDustRaw").textContent = "";
      issues.push("DUST balance response was not in the expected integer format.");
    }
  } else {
    $("#connectedWalletDust").textContent = "Balance unavailable";
    $("#connectedWalletDustRaw").textContent = "";
    issues.push("DUST balance permission or response unavailable.");
  }

  setWalletError(issues.join(" "));
  refreshButton.disabled = false;
  refreshButton.textContent = "Refresh read-only data";
  setWalletStatus(`${walletState.selectedProvider.kind} is connected to Preprod. Address and DUST data below are read-only; this is not a SILENCE server session.`, "connected");
}

async function connectSelectedWallet() {
  if (walletState.connecting || walletState.connectedApi || !walletState.providers.length) return;
  const selectedIndex = Number($("#walletProviderSelect").value || 0);
  const provider = walletState.providers[selectedIndex];
  if (!provider?.connect) return;

  walletState.connecting = true;
  renderProviderOptions();
  const button = $("#connectWalletButton");
  button.textContent = `Connecting to ${provider.kind}…`;
  setWalletError("");
  setWalletStatus(`Asking ${provider.kind} to connect this page to Preprod. Approve only in the wallet if you want to share read-only address and DUST data.`, "connecting");

  try {
    const api = await provider.connect(TARGET_NETWORK);
    if (!record(api)) throw new TypeError("Wallet returned an invalid connected API.");
    walletState.connectedApi = api;
    walletState.selectedProvider = provider;
    $("#connectedWalletName").textContent = `${provider.kind} · ${provider.name}`;
    $("#connectedWalletVersion").textContent = provider.apiVersion;
    const network = await checkConnectedNetwork(api);
    walletState.detectedNetwork = network.networkId;
    walletState.networkMatches = network.matches;
    $("#connectedWalletNetwork").textContent = network.networkId;
    setDetailsVisible(true);
    renderProviderOptions();
    if (!network.matches) {
      $("#refreshWalletData").disabled = true;
      setWalletStatus(`Network mismatch: this app requires Preprod, but the wallet reports ${network.networkId}. Wallet data will not be read.`, "network-mismatch");
      return;
    }
    setWalletStatus(`${provider.kind} connected to Preprod. Reading the unshielded address, DUST address and DUST balance only.`, "connected");
    await refreshWalletData();
  } catch (error) {
    walletState.connectedApi = null;
    walletState.selectedProvider = null;
    walletState.detectedNetwork = "";
    walletState.networkMatches = false;
    setDetailsVisible(false);
    setWalletError(apiErrorMessage(error));
    setWalletStatus("Wallet connection failed. Check the wallet and try again.", "error");
  } finally {
    walletState.connecting = false;
    renderProviderOptions();
    if (!walletState.connectedApi) button.textContent = walletState.providers.length ? "Try connecting again" : "Scan again";
  }
}

function toggleWalletPanel() {
  const panel = $("#walletPanel");
  panel.hidden = !panel.hidden;
  $("#walletStatus").setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden) panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function clearWalletView() {
  walletState.connectedApi = null;
  walletState.selectedProvider = null;
  walletState.detectedNetwork = "";
  walletState.networkMatches = false;
  setDetailsVisible(false);
  $("#connectedWalletName").textContent = "—";
  $("#connectedWalletVersion").textContent = "—";
  $("#connectedWalletNetwork").textContent = "—";
  $("#connectedWalletDust").textContent = "—";
  $("#connectedWalletDustRaw").textContent = "";
  $("#connectedUnshieldedAddress").textContent = "—";
  $("#connectedDustAddress").textContent = "—";
  setWalletError("");
  renderProviderOptions();
  setWalletStatus("Wallet details were cleared from this page. The wallet extension may still remember its site permission.", walletState.providers.length ? "available" : "idle");
}

export const midnightWalletAdapter = {
  init() {
    if (initialized) return;
    initialized = true;
    $("#walletStatus").addEventListener("click", toggleWalletPanel);
    $("#connectWalletButton").addEventListener("click", () => {
      if (walletState.providers.length) connectSelectedWallet();
      else scanWallets();
    });
    $("#refreshWalletData").addEventListener("click", refreshWalletData);
    $("#clearWalletView").addEventListener("click", clearWalletView);
    window.addEventListener("midnight#ready", scanWallets);
    scanWallets();
  },
};
