import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { realpath, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FairLaunchCreateBusyError,
  FairLaunchCreateUnavailableError,
  FairLaunchInputError,
  FairLaunchRecoveryRequiredError,
  isLocalDevnetCatalogEntry,
  readFairLaunchCatalog,
  type FairLaunchCreateAdapter,
  type FairLaunchEntry,
} from "./fair-launch-create.ts";

export type MarketSymbol = "BTC-USD";
export type CandleInterval = "15m" | "1h" | "4h" | "1d";
export type OracleSource = "demo" | "external";
export type OperationState = "pending" | "proving" | "submitted" | "confirmed" | "error";

export interface OracleView {
  readonly price: string;
  readonly sequence: number;
  readonly updatedAt: string;
  readonly source: OracleSource;
}

export interface MarketView {
  readonly market: MarketSymbol;
  readonly markPrice: string;
  readonly oracle: OracleView;
  readonly policy: {
    readonly fixedCollateralLot: "1000";
    readonly maxLeverageBps: number;
    readonly maintenanceMarginBps: number;
    readonly estimatedExitCost: string;
    readonly profitPayoutCap: string;
    readonly riskSlotLiability: string;
    readonly availableRiskReserve: string;
  };
}

export interface CandleView {
  readonly time: string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
}

export interface ObserverView {
  readonly oracle: OracleView;
  readonly policyVersion: string;
  readonly occupiedRiskSlots: number;
  readonly fixedCollateralLot: "1000";
}

export interface PrivatePositionView {
  readonly id: string;
  readonly side: "long" | "short";
  readonly notional: string;
  readonly collateral: "1000";
  readonly entryPrice: string;
  readonly markPrice: string;
  readonly pnl: string;
  readonly equity: string;
  readonly maintenance: string;
  readonly buffer: string;
  readonly guardBuffer: string;
  readonly status: string;
}

export interface OpenIntent {
  readonly market: MarketSymbol;
  readonly side: "long" | "short";
  readonly notional: string;
  readonly leverage: string;
  readonly guardBuffer: string;
  /** Supplied by the server, never accepted from the browser. */
  readonly fixedCollateralLot: "1000";
}

export interface OperationSnapshot {
  readonly operationId: string;
  readonly state: OperationState;
  readonly txHash?: string;
  readonly explorerUrl?: string;
  readonly error?: string;
  /** Both facts are required before this API will expose `confirmed`. */
  readonly chainReceiptObserved?: boolean;
  readonly requiredStateReadbackVerified?: boolean;
}

export interface AuthenticatedWallet {
  /** Private owner identifier; it is never returned by an HTTP handler. */
  readonly ownerId: string;
}

const ownerCapabilityBrand = Symbol("silence-verified-owner-capability");

/** Created only after the injected wallet authenticator returns an owner. */
export interface VerifiedOwnerCapability {
  readonly ownerId: string;
  readonly [ownerCapabilityBrand]: true;
}

export interface SilenceDataProvider {
  /** Read the accepted oracle and policy state from a real data source. */
  readMarket(market: MarketSymbol): Promise<MarketView | null>;
  /** Read actual accepted oracle history; an empty list means no history exists. */
  readCandles?(market: MarketSymbol, interval: CandleInterval, limit: number): Promise<readonly CandleView[] | null>;
  /** Read aggregate public state. The HTTP layer still removes unknown fields. */
  readObserver(market: MarketSymbol): Promise<ObserverView | null>;
  /** Return only the authenticated owner's positions. */
  readPrivatePositions?(owner: VerifiedOwnerCapability): Promise<readonly PrivatePositionView[] | null>;
}

export interface WalletAuthenticator {
  /**
   * Must verify possession of a random owner capability bound to an on-chain
   * commitment. A connected address, browser cookie, or wallet identity alone
   * is not authorization and must return null.
   */
  authenticateOwner(request: IncomingMessage): Promise<AuthenticatedWallet | null>;
}

export interface OpenPositionAdapter {
  /**
   * Must perform Compact proof validation/generation and submit a real chain
   * operation. The preparation flow must persist the encrypted pending witness
   * before the wallet transaction; activate only after receipt, commitment,
   * and fixed-lot lock readback. It must never invent operation state.
   */
  openPosition(owner: VerifiedOwnerCapability, intent: OpenIntent): Promise<OperationSnapshot>;
  /** `confirmed` results require an observed receipt and required state readback. */
  readOperation(owner: VerifiedOwnerCapability, operationId: string): Promise<OperationSnapshot | null>;
}

export interface SilenceServerOptions {
  readonly dataProvider?: SilenceDataProvider;
  readonly walletAuthenticator?: WalletAuthenticator;
  readonly openAdapter?: OpenPositionAdapter;
  readonly fairLaunchCreateAdapter?: FairLaunchCreateAdapter;
  readonly fairLaunchCatalogPath?: string;
  readonly webRoot?: string;
  readonly maxBodyBytes?: number;
}

const FIXED_COLLATERAL_LOT = "1000" as const;
const TOKEN_ATOMS_PER_UNIT = 1_000_000n;
const MAX_GUARD_BUFFER_ATOMS = 1_000n * TOKEN_ATOMS_PER_UNIT;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../web", import.meta.url));
const intervals = new Set<CandleInterval>(["15m", "1h", "4h", "1d"]);
const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validDecimal(value: unknown, allowNegative = false): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  return (allowNegative ? /^-?\d+(?:\.\d+)?$/ : /^\d+(?:\.\d+)?$/).test(value);
}

function decimalParts(value: string): { whole: bigint; fraction: string } {
  const [whole, fraction = ""] = value.split(".");
  return { whole: BigInt(whole || "0"), fraction: fraction.replace(/0+$/, "") };
}

function decimalToAtoms(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole || "0") * TOKEN_ATOMS_PER_UNIT + BigInt(fraction.padEnd(6, "0") || "0");
}

function normalizedDecimal(value: string): string {
  const { whole, fraction } = decimalParts(value);
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function compareDecimals(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.fraction.length, b.fraction.length);
  const scaleFactor = 10n ** BigInt(scale);
  const aValue = a.whole * scaleFactor + BigInt(a.fraction.padEnd(scale, "0") || "0");
  const bValue = b.whole * scaleFactor + BigInt(b.fraction.padEnd(scale, "0") || "0");
  return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
}

function validIsoUtc(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function validateOracle(value: unknown): OracleView {
  if (!isRecord(value) || !validDecimal(value.price) || compareDecimals(value.price, "0") <= 0 ||
      !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0 ||
      !validIsoUtc(value.updatedAt) || (value.source !== "demo" && value.source !== "external")) {
    throw new HttpFailure(503, "market_unavailable", "The market data is temporarily unavailable.");
  }
  return {
    price: value.price,
    sequence: Number(value.sequence),
    updatedAt: value.updatedAt,
    source: value.source,
  };
}

function serializeMarket(value: unknown): MarketView {
  if (!isRecord(value) || value.market !== "BTC-USD") {
    throw new HttpFailure(503, "market_unavailable", "The market data is temporarily unavailable.");
  }
  const oracle = validateOracle(value.oracle);
  if (!validDecimal(value.markPrice) || compareDecimals(value.markPrice, "0") <= 0 ||
      normalizedDecimal(value.markPrice) !== normalizedDecimal(oracle.price) || !isRecord(value.policy)) {
    throw new HttpFailure(503, "market_unavailable", "The market data is temporarily unavailable.");
  }
  const policy = value.policy;
  const maxLeverageBps = policy.maxLeverageBps;
  const maintenanceMarginBps = policy.maintenanceMarginBps;
  if (policy.fixedCollateralLot !== FIXED_COLLATERAL_LOT ||
      !Number.isSafeInteger(maxLeverageBps) || Number(maxLeverageBps) < 10_000 ||
      !Number.isSafeInteger(maintenanceMarginBps) || Number(maintenanceMarginBps) < 0 || Number(maintenanceMarginBps) > 10_000 ||
      !validDecimal(policy.estimatedExitCost) || !validDecimal(policy.profitPayoutCap) ||
      !validDecimal(policy.riskSlotLiability) || !validDecimal(policy.availableRiskReserve)) {
    throw new HttpFailure(503, "market_unavailable", "The market policy is temporarily unavailable.");
  }
  return {
    market: "BTC-USD",
    markPrice: value.markPrice,
    oracle,
    policy: {
      fixedCollateralLot: FIXED_COLLATERAL_LOT,
      maxLeverageBps: Number(maxLeverageBps),
      maintenanceMarginBps: Number(maintenanceMarginBps),
      estimatedExitCost: policy.estimatedExitCost,
      profitPayoutCap: policy.profitPayoutCap,
      riskSlotLiability: policy.riskSlotLiability,
      availableRiskReserve: policy.availableRiskReserve,
    },
  };
}

function serializeObserver(value: unknown): ObserverView {
  if (!isRecord(value) || typeof value.policyVersion !== "string" || value.policyVersion.length === 0 ||
      value.policyVersion.length > 128 || !Number.isSafeInteger(value.occupiedRiskSlots) ||
      Number(value.occupiedRiskSlots) < 0 || value.fixedCollateralLot !== FIXED_COLLATERAL_LOT) {
    throw new HttpFailure(503, "observer_unavailable", "The observer data is temporarily unavailable.");
  }
  const oracle = validateOracle(value.oracle);
  return {
    oracle,
    policyVersion: value.policyVersion,
    occupiedRiskSlots: Number(value.occupiedRiskSlots),
    fixedCollateralLot: FIXED_COLLATERAL_LOT,
  };
}

function serializeCandles(value: unknown): { readonly candles: readonly CandleView[] } {
  if (!Array.isArray(value)) {
    throw new HttpFailure(503, "history_unavailable", "Oracle history is temporarily unavailable.");
  }
  const candles = value.map((item): CandleView => {
    if (!isRecord(item) || !validIsoUtc(item.time) ||
        !validDecimal(item.open) || compareDecimals(item.open, "0") <= 0 ||
        !validDecimal(item.high) || compareDecimals(item.high, "0") <= 0 ||
        !validDecimal(item.low) || compareDecimals(item.low, "0") <= 0 ||
        !validDecimal(item.close) || compareDecimals(item.close, "0") <= 0 ||
        !validDecimal(item.volume) || compareDecimals(item.low, item.high) > 0 ||
        compareDecimals(item.open, item.high) > 0 || compareDecimals(item.open, item.low) < 0 ||
        compareDecimals(item.close, item.high) > 0 || compareDecimals(item.close, item.low) < 0) {
      throw new HttpFailure(503, "history_unavailable", "Oracle history is temporarily unavailable.");
    }
    return {
      time: item.time,
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close,
      volume: item.volume,
    };
  });
  return { candles };
}

function serializePositions(value: unknown): { readonly positions: readonly PrivatePositionView[] } {
  if (!Array.isArray(value)) {
    throw new HttpFailure(503, "positions_unavailable", "Private positions are temporarily unavailable.");
  }
  const positions = value.map((item): PrivatePositionView => {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0 || item.id.length > 200 ||
        (item.side !== "long" && item.side !== "short") || item.collateral !== FIXED_COLLATERAL_LOT ||
        typeof item.status !== "string" || item.status.length === 0 || item.status.length > 64 ||
        !validDecimal(item.notional) || compareDecimals(item.notional, "0") <= 0 ||
        !validDecimal(item.entryPrice) || compareDecimals(item.entryPrice, "0") <= 0 ||
        !validDecimal(item.markPrice) || compareDecimals(item.markPrice, "0") <= 0 ||
        !validDecimal(item.pnl, true) || !validDecimal(item.equity, true) ||
        !validDecimal(item.maintenance) || !validDecimal(item.buffer, true) || !validDecimal(item.guardBuffer)) {
      throw new HttpFailure(503, "positions_unavailable", "Private positions are temporarily unavailable.");
    }
    return {
      id: item.id,
      side: item.side,
      notional: item.notional,
      collateral: FIXED_COLLATERAL_LOT,
      entryPrice: item.entryPrice,
      markPrice: item.markPrice,
      pnl: item.pnl,
      equity: item.equity,
      maintenance: item.maintenance,
      buffer: item.buffer,
      guardBuffer: item.guardBuffer,
      status: item.status,
    };
  });
  return { positions };
}

function serializeOperation(value: unknown): OperationSnapshot {
  if (!isRecord(value) || typeof value.operationId !== "string" || value.operationId.length === 0 ||
      value.operationId.length > 200 || /[\r\n\0]/.test(value.operationId) ||
      !["pending", "proving", "submitted", "confirmed", "error"].includes(String(value.state))) {
    throw new HttpFailure(503, "operation_unavailable", "The operation status is temporarily unavailable.");
  }
  const state = value.state as OperationState;
  if (state === "confirmed" && (value.chainReceiptObserved !== true || value.requiredStateReadbackVerified !== true)) {
    throw new HttpFailure(503, "operation_unverified", "The operation could not be verified on chain.");
  }
  if (value.txHash !== undefined && (typeof value.txHash !== "string" || value.txHash.length === 0 || value.txHash.length > 200 ||
      /[\r\n\0]/.test(value.txHash) || (state !== "submitted" && state !== "confirmed"))) {
    throw new HttpFailure(503, "operation_unavailable", "The operation status is temporarily unavailable.");
  }
  if (value.explorerUrl !== undefined && (typeof value.explorerUrl !== "string" ||
      typeof value.txHash !== "string" || !isSafeExplorerUrl(value.explorerUrl))) {
    throw new HttpFailure(503, "operation_unavailable", "The operation status is temporarily unavailable.");
  }
  const result: {
    operationId: string;
    state: OperationState;
    txHash?: string;
    explorerUrl?: string;
    error?: string;
  } = { operationId: value.operationId, state };
  if (typeof value.txHash === "string") result.txHash = value.txHash;
  if (typeof value.explorerUrl === "string") result.explorerUrl = value.explorerUrl;
  if (state === "error") result.error = "The operation could not be completed.";
  return result;
}

function isSafeExplorerUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

function parseRequestTarget(target: string | undefined): { rawPath: string; decodedPath: string; url: URL } {
  const requestTarget = target ?? "/";
  const queryStart = requestTarget.indexOf("?");
  const rawPath = queryStart === -1 ? requestTarget : requestTarget.slice(0, queryStart);
  if (!rawPath.startsWith("/") || rawPath.startsWith("//") || rawPath.includes("\\") || rawPath.includes("\0")) {
    throw new HttpFailure(400, "invalid_path", "The request path is invalid.");
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    throw new HttpFailure(400, "invalid_path", "The request path is invalid.");
  }
  if (decodedPath.includes("\\") || decodedPath.includes("\0") || decodedPath.split("/").some((part) => part === "." || part === "..")) {
    throw new HttpFailure(400, "invalid_path", "The request path is invalid.");
  }
  let url: URL;
  try {
    url = new URL(requestTarget, "http://silence.local");
  } catch {
    throw new HttpFailure(400, "invalid_path", "The request path is invalid.");
  }
  return { rawPath, decodedPath, url };
}

function jsonResponse(response: ServerResponse, status: number, body: unknown, headOnly = false): void {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": payload.byteLength,
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(headOnly ? undefined : payload);
}

function failureResponse(response: ServerResponse, error: unknown, headOnly = false): void {
  if (error instanceof HttpFailure) {
    jsonResponse(response, error.status, { error: { code: error.code, message: error.safeMessage } }, headOnly);
    return;
  }
  jsonResponse(response, 503, {
    error: { code: "service_unavailable", message: "The SILENCE service is temporarily unavailable." },
  }, headOnly);
}

function setDefaultSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function parseMarketOpenIntent(value: unknown, maxLeverageBps: number): OpenIntent {
  if (!isRecord(value) || Object.keys(value).some((key) => !["market", "side", "notional", "leverage", "guardBuffer"].includes(key)) ||
      value.market !== "BTC-USD" || (value.side !== "long" && value.side !== "short") ||
      !validDecimal(value.notional) || compareDecimals(value.notional, "0") <= 0 ||
      !validDecimal(value.leverage) || !validDecimal(value.guardBuffer)) {
    throw new HttpFailure(400, "invalid_order", "The open request is invalid.");
  }
  if ((value.notional.split(".")[1]?.length ?? 0) > 6 ||
      (value.guardBuffer.split(".")[1]?.length ?? 0) > 6 ||
      (value.leverage.split(".")[1]?.length ?? 0) > 4) {
    throw new HttpFailure(400, "invalid_order", "The open request is invalid.");
  }
  const guardBufferAtoms = decimalToAtoms(value.guardBuffer);
  if (guardBufferAtoms <= 0n || guardBufferAtoms > MAX_GUARD_BUFFER_ATOMS) {
    throw new HttpFailure(400, "invalid_order", "The protection buffer must be greater than zero and at most 1000 units.");
  }
  const leverageParts = decimalParts(value.leverage);
  if (leverageParts.whole < 1n || (leverageParts.fraction.length > 4)) {
    throw new HttpFailure(400, "invalid_order", "The open request is invalid.");
  }
  const leverageBps = leverageParts.whole * 10_000n + BigInt(leverageParts.fraction.padEnd(4, "0") || "0");
  if (leverageBps < 10_000n || leverageBps > BigInt(maxLeverageBps)) {
    throw new HttpFailure(400, "invalid_order", "The open request is outside the current market policy.");
  }
  const notionalParts = decimalParts(value.notional);
  const notionalAtoms = notionalParts.whole * 1_000_000n + BigInt(notionalParts.fraction.padEnd(6, "0") || "0");
  const expectedNotionalAtoms = 1_000n * 1_000_000n * leverageBps / 10_000n;
  if (notionalAtoms !== expectedNotionalAtoms) {
    throw new HttpFailure(400, "invalid_order", "The request does not match the fixed collateral lot.");
  }
  return {
    market: "BTC-USD",
    side: value.side,
    notional: value.notional,
    leverage: value.leverage,
    guardBuffer: value.guardBuffer,
    fixedCollateralLot: FIXED_COLLATERAL_LOT,
  };
}

async function readJsonBody(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    request.resume();
    throw new HttpFailure(415, "unsupported_media_type", "Send this request as JSON.");
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maximumBytes) {
      request.resume();
      throw new HttpFailure(413, "request_too_large", "The request is too large.");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpFailure(400, "invalid_json", "The request body is not valid JSON.");
  }
}

function isLoopbackHost(hostname: string): boolean {
  const unwrapped = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (unwrapped === "localhost") return true;
  if (isIP(unwrapped) === 4) return unwrapped.split(".")[0] === "127";
  return isIP(unwrapped) === 6 && unwrapped === "::1";
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split("%", 1)[0] ?? "";
  if (normalized.startsWith("::ffff:")) return isLoopbackHost(normalized.slice("::ffff:".length));
  return isLoopbackHost(normalized);
}

function requireFairLaunchSameOriginLoopback(request: IncomingMessage): void {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw new HttpFailure(403, "local_demo_only", "Fair Launch creation is available only from this machine.");
  }
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== "string" || typeof host !== "string") {
    throw new HttpFailure(403, "same_origin_required", "Fair Launch creation requires a same-origin browser request.");
  }
  try {
    const originUrl = new URL(origin);
    const hostUrl = new URL(`http://${host}`);
    if (origin !== originUrl.origin || originUrl.protocol !== "http:" || !isLoopbackHost(originUrl.hostname) ||
        originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase() || hostUrl.protocol !== "http:" ||
        hostUrl.username || hostUrl.password || hostUrl.pathname !== "/" || hostUrl.search || hostUrl.hash) {
      throw new Error("origin mismatch");
    }
  } catch {
    throw new HttpFailure(403, "same_origin_required", "Fair Launch creation requires a same-origin browser request.");
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (typeof fetchSite === "string" && fetchSite !== "same-origin") {
    throw new HttpFailure(403, "same_origin_required", "Fair Launch creation requires a same-origin browser request.");
  }
}

function serializeFairLaunchEntry(value: unknown): FairLaunchEntry {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length < 1 || value.id.length > 256 ||
      typeof value.contractAddress !== "string" || !/^[0-9a-f]{64}$/i.test(value.contractAddress) ||
      value.id !== value.contractAddress ||
      !isRecord(value.metadata) || !isRecord(value.config) ||
      !["commit", "open", "settled", "cancelled", "unknown"].includes(String(value.phase)) ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.metadataAnchored !== "boolean" ||
      !(value.metadataCommitmentHex === null || (typeof value.metadataCommitmentHex === "string" && /^[0-9a-f]{64}$/i.test(value.metadataCommitmentHex))) ||
      value.artworkBytesAnchored !== false ||
      (value.evidenceSource !== "recorded-local-devnet-evidence" && value.evidenceSource !== "verified-local-devnet-create") ||
      !isRecord(value.receipts)) {
    throw new HttpFailure(503, "fair_launch_unavailable", "The verified launch catalog is temporarily unavailable.");
  }

  const metadata = value.metadata;
  const nullMetadata = metadata.name === null && metadata.ticker === null && metadata.imageUrl === null && metadata.description === null;
  if (!nullMetadata && (typeof metadata.name !== "string" || typeof metadata.ticker !== "string" ||
      !(metadata.imageUrl === null || typeof metadata.imageUrl === "string") || typeof metadata.description !== "string")) {
    throw new HttpFailure(503, "fair_launch_unavailable", "The verified launch catalog is temporarily unavailable.");
  }
  const config = value.config;
  const amounts = [config.inventoryAtoms, config.reservePriceAtoms, config.depositLotAtoms];
  const isPositiveUint64 = (amount: unknown): amount is string => typeof amount === "string" && /^[1-9]\d{0,19}$/.test(amount) && BigInt(amount) <= 18_446_744_073_709_551_615n;
  if (!amounts.every(isPositiveUint64) ||
      !Number.isSafeInteger(config.commitWindowSeconds) || Number(config.commitWindowSeconds) < 300 || Number(config.commitWindowSeconds) > 86_400 ||
      !Number.isSafeInteger(config.openWindowSeconds) || Number(config.openWindowSeconds) < 300 || Number(config.openWindowSeconds) > 86_400 ||
      BigInt(config.inventoryAtoms as string) * BigInt(config.reservePriceAtoms as string) > BigInt(config.depositLotAtoms as string)) {
    throw new HttpFailure(503, "fair_launch_unavailable", "The verified launch catalog is temporarily unavailable.");
  }

  const commitDeadlineUnixSeconds = value.commitDeadlineUnixSeconds;
  const openDeadlineUnixSeconds = value.openDeadlineUnixSeconds;
  if ((commitDeadlineUnixSeconds !== undefined && !isPositiveUint64(commitDeadlineUnixSeconds)) ||
      (openDeadlineUnixSeconds !== undefined && !isPositiveUint64(openDeadlineUnixSeconds)) ||
      ((commitDeadlineUnixSeconds === undefined) !== (openDeadlineUnixSeconds === undefined)) ||
      (commitDeadlineUnixSeconds !== undefined && openDeadlineUnixSeconds !== undefined &&
        BigInt(commitDeadlineUnixSeconds) >= BigInt(openDeadlineUnixSeconds))) {
    throw new HttpFailure(503, "fair_launch_unavailable", "The verified launch catalog is temporarily unavailable.");
  }

  const receipts = value.receipts;
  const receipt = (candidate: unknown) => {
    if (!isRecord(candidate) || typeof candidate.txId !== "string" || candidate.txId.length < 1 || candidate.txId.length > 256 ||
        typeof candidate.transactionHash !== "string" || candidate.transactionHash.length < 1 || candidate.transactionHash.length > 256 ||
        !Number.isSafeInteger(candidate.blockHeight) || Number(candidate.blockHeight) < 0) {
      throw new HttpFailure(503, "fair_launch_unavailable", "The verified launch catalog is temporarily unavailable.");
    }
    return { txId: candidate.txId, transactionHash: candidate.transactionHash, blockHeight: Number(candidate.blockHeight) };
  };

  let settlementOutput: FairLaunchEntry["settlement"] = undefined;
  if (value.settlement !== undefined) {
    if (!isRecord(value.settlement)) throw new HttpFailure(503, "fair_launch_unavailable", "The verified launch catalog is temporarily unavailable.");
    const settlement = value.settlement;
    const nonnegativeAtoms = (candidate: unknown): candidate is string =>
      typeof candidate === "string" && /^(?:0|[1-9]\d{0,19})$/.test(candidate) && BigInt(candidate) <= 18_446_744_073_709_551_615n;
    const fixedSlots = (candidate: unknown, predicate: (item: unknown) => boolean): candidate is unknown[] =>
      Array.isArray(candidate) && candidate.length === 4 && candidate.every(predicate);
    if (!nonnegativeAtoms(settlement.clearingPriceAtoms) ||
        !fixedSlots(settlement.allocationsAtoms, nonnegativeAtoms) || !fixedSlots(settlement.refundsAtoms, nonnegativeAtoms) ||
        !fixedSlots(settlement.tokenClaimed, (item) => typeof item === "boolean") ||
        !fixedSlots(settlement.refundClaimed, (item) => typeof item === "boolean")) {
      throw new HttpFailure(503, "fair_launch_unavailable", "The verified launch catalog is temporarily unavailable.");
    }
    settlementOutput = {
      clearingPriceAtoms: settlement.clearingPriceAtoms,
      allocationsAtoms: settlement.allocationsAtoms as string[],
      refundsAtoms: settlement.refundsAtoms as string[],
      tokenClaimed: settlement.tokenClaimed as boolean[],
      refundClaimed: settlement.refundClaimed as boolean[],
    };
  }

  const output: FairLaunchEntry = {
    id: value.id,
    contractAddress: value.contractAddress,
    metadata: nullMetadata ? { name: null, ticker: null, imageUrl: null, description: null } : {
      name: metadata.name as string,
      ticker: metadata.ticker as string,
      imageUrl: metadata.imageUrl as string | null,
      description: metadata.description as string,
    },
    config: {
      inventoryAtoms: config.inventoryAtoms as string,
      reservePriceAtoms: config.reservePriceAtoms as string,
      depositLotAtoms: config.depositLotAtoms as string,
      commitWindowSeconds: Number(config.commitWindowSeconds),
      openWindowSeconds: Number(config.openWindowSeconds),
    },
    phase: value.phase as FairLaunchEntry["phase"],
    createdAt: value.createdAt,
    metadataAnchored: value.metadataAnchored,
    metadataCommitmentHex: value.metadataCommitmentHex as string | null,
    artworkBytesAnchored: false,
    evidenceSource: value.evidenceSource,
    receipts: {
      deploy: receipt(receipts.deploy),
      mint: receipt(receipts.mint),
      fund: receipt(receipts.fund),
    },
    ...(commitDeadlineUnixSeconds !== undefined && openDeadlineUnixSeconds !== undefined
      ? { commitDeadlineUnixSeconds, openDeadlineUnixSeconds }
      : {}),
    ...(settlementOutput ? { settlement: settlementOutput } : {}),
  };
  return output;
}

function serializeFairLaunchSnapshot(value: unknown): {
  live: boolean;
  writable: boolean;
  network: "local-devnet";
  mode: "local-devnet-operator-demo";
  capabilities: { canCreate: boolean };
  launches: FairLaunchEntry[];
} {
  if (!isRecord(value) || typeof value.live !== "boolean" || typeof value.writable !== "boolean" ||
      value.network !== "local-devnet" || value.mode !== "local-devnet-operator-demo" ||
      !isRecord(value.capabilities) || typeof value.capabilities.canCreate !== "boolean" || !Array.isArray(value.launches)) {
    throw new HttpFailure(503, "fair_launch_unavailable", "Fair Launch data is temporarily unavailable.");
  }
  const launches = value.launches.map(serializeFairLaunchEntry);
  const writable = value.writable && value.live && value.capabilities.canCreate;
  return {
    live: value.live,
    writable,
    network: "local-devnet",
    mode: "local-devnet-operator-demo",
    capabilities: { canCreate: writable },
    launches,
  };
}

async function makeOwnerCapability(
  request: IncomingMessage,
  authenticator: WalletAuthenticator | undefined,
): Promise<VerifiedOwnerCapability | null> {
  if (!authenticator) return null;
  const wallet = await authenticator.authenticateOwner(request);
  if (!wallet || typeof wallet.ownerId !== "string" || wallet.ownerId.length === 0 ||
      wallet.ownerId.length > 512 || /[\r\n\0]/.test(wallet.ownerId)) return null;
  return Object.freeze({ ownerId: wallet.ownerId, [ownerCapabilityBrand]: true as const });
}

async function serveStatic(
  response: ServerResponse,
  path: string,
  webRootPromise: Promise<string>,
  headOnly: boolean,
): Promise<void> {
  const root = await webRootPromise;
  const relativePath = path === "/" ? "/index.html" : path;
  const candidate = resolve(root, `.${relativePath}`);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new HttpFailure(404, "not_found", "The requested file was not found.");
  }
  let actualPath: string;
  try {
    actualPath = await realpath(candidate);
  } catch {
    throw new HttpFailure(404, "not_found", "The requested file was not found.");
  }
  if (actualPath !== root && !actualPath.startsWith(`${root}${sep}`)) {
    throw new HttpFailure(404, "not_found", "The requested file was not found.");
  }
  let payload: Buffer;
  try {
    payload = await readFile(actualPath);
  } catch {
    throw new HttpFailure(404, "not_found", "The requested file was not found.");
  }
  const type = contentTypes[extname(actualPath).toLowerCase()];
  if (!type) throw new HttpFailure(404, "not_found", "The requested file was not found.");
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Length": payload.byteLength,
    "Content-Type": type,
  });
  response.end(headOnly ? undefined : payload);
}

async function routeApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: SilenceServerOptions,
): Promise<void> {
  const { pathname, searchParams } = url;
  const method = request.method ?? "GET";
  const provider = options.dataProvider;

  if (pathname === "/api/fair-launch/launches" && method === "GET") {
    let snapshot;
    if (options.fairLaunchCreateAdapter) {
      snapshot = await options.fairLaunchCreateAdapter.getSnapshot();
    } else {
      snapshot = {
        live: false,
        writable: false,
        network: "local-devnet" as const,
        mode: "local-devnet-operator-demo" as const,
        capabilities: { canCreate: false },
        launches: (await readFairLaunchCatalog(options.fairLaunchCatalogPath)).filter(isLocalDevnetCatalogEntry),
      };
    }
    jsonResponse(response, 200, serializeFairLaunchSnapshot(snapshot));
    return;
  }

  if (pathname === "/api/fair-launch/create" && method === "POST") {
    requireFairLaunchSameOriginLoopback(request);
    if (!options.fairLaunchCreateAdapter) {
      request.resume();
      throw new HttpFailure(503, "create_unavailable", "Local Devnet token creation is not enabled.");
    }
    const body = await readJsonBody(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    try {
      const launch = serializeFairLaunchEntry(await options.fairLaunchCreateAdapter.create(body));
      if (launch.evidenceSource !== "verified-local-devnet-create") {
        throw new Error("create adapter returned an unverified entry");
      }
      jsonResponse(response, 201, { status: "confirmed", launch });
    } catch (error) {
      if (error instanceof FairLaunchInputError) {
        throw new HttpFailure(400, "invalid_launch", error.message);
      }
      if (error instanceof FairLaunchCreateBusyError) {
        throw new HttpFailure(409, "create_busy", "A Fair Launch create operation is already running.");
      }
      if (error instanceof FairLaunchCreateUnavailableError) {
        throw new HttpFailure(503, "create_unavailable", "Local Devnet token creation is not available.");
      }
      if (error instanceof FairLaunchRecoveryRequiredError) {
        jsonResponse(response, 503, {
          error: {
            code: "create_recovery_required",
            message: "A partial Local Devnet operation needs manual recovery. No retry was made.",
            operationId: error.operationId,
          },
        });
        return;
      }
      throw new HttpFailure(503, "create_failed", "The launch could not be confirmed. Check the recovery status before retrying.");
    }
    return;
  }

  if (pathname === "/api/v1/market/BTC-USD" && method === "GET") {
    if (!provider) throw new HttpFailure(503, "market_unavailable", "The market data is temporarily unavailable.");
    const result = await provider.readMarket("BTC-USD");
    if (!result) throw new HttpFailure(503, "market_unavailable", "The market data is temporarily unavailable.");
    jsonResponse(response, 200, serializeMarket(result));
    return;
  }

  if (pathname === "/api/v1/market/BTC-USD/candles" && method === "GET") {
    const interval = searchParams.get("interval") ?? "1h";
    const limitText = searchParams.get("limit") ?? "120";
    const limit = Number(limitText);
    if (!intervals.has(interval as CandleInterval) || !/^\d+$/.test(limitText) || !Number.isSafeInteger(limit) || limit < 1 || limit > 120) {
      throw new HttpFailure(400, "invalid_query", "The candle interval or limit is invalid.");
    }
    if (!provider) throw new HttpFailure(503, "history_unavailable", "Oracle history is temporarily unavailable.");
    const rows = provider.readCandles
      ? await provider.readCandles("BTC-USD", interval as CandleInterval, limit)
      : [];
    if (rows === null) throw new HttpFailure(503, "history_unavailable", "Oracle history is temporarily unavailable.");
    jsonResponse(response, 200, serializeCandles(rows));
    return;
  }

  if (pathname === "/api/v1/observer/market/BTC-USD" && method === "GET") {
    if (!provider) throw new HttpFailure(503, "observer_unavailable", "The observer data is temporarily unavailable.");
    const result = await provider.readObserver("BTC-USD");
    if (!result) throw new HttpFailure(503, "observer_unavailable", "The observer data is temporarily unavailable.");
    jsonResponse(response, 200, serializeObserver(result));
    return;
  }

  if (pathname === "/api/v1/private/positions" && method === "GET") {
    const owner = await makeOwnerCapability(request, options.walletAuthenticator);
    if (!owner) throw new HttpFailure(401, "wallet_auth_required", "Connect an authenticated test wallet to view private positions.");
    if (!provider?.readPrivatePositions) throw new HttpFailure(503, "positions_unavailable", "Private positions are temporarily unavailable.");
    const positions = await provider.readPrivatePositions(owner);
    if (positions === null) throw new HttpFailure(503, "positions_unavailable", "Private positions are temporarily unavailable.");
    jsonResponse(response, 200, serializePositions(positions));
    return;
  }

  if (pathname === "/api/v1/private/positions/open" && method === "POST") {
    const owner = await makeOwnerCapability(request, options.walletAuthenticator);
    if (!owner) {
      request.resume();
      throw new HttpFailure(401, "wallet_auth_required", "Connect an authenticated test wallet to open a position.");
    }
    if (!provider || !options.openAdapter) {
      request.resume();
      throw new HttpFailure(503, "trading_not_ready", "Wallet authorization, Compact proof, and chain readback are not configured.");
    }
    const body = await readJsonBody(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    const market = await provider.readMarket("BTC-USD");
    if (!market) throw new HttpFailure(503, "market_unavailable", "The market policy is temporarily unavailable.");
    const validMarket = serializeMarket(market);
    if (validMarket.oracle.source !== "demo") {
      throw new HttpFailure(503, "trading_not_ready", "Open requests require the accepted permissioned demo oracle.");
    }
    const intent = parseMarketOpenIntent(body, validMarket.policy.maxLeverageBps);
    const operation = await options.openAdapter.openPosition(owner, intent);
    jsonResponse(response, 202, serializeOperation(operation));
    return;
  }

  const operationMatch = pathname.match(/^\/api\/v1\/operations\/([^/]+)$/);
  if (operationMatch && method === "GET") {
    const owner = await makeOwnerCapability(request, options.walletAuthenticator);
    if (!owner) throw new HttpFailure(401, "wallet_auth_required", "Connect an authenticated test wallet to view operation status.");
    if (!options.openAdapter) throw new HttpFailure(503, "operation_unavailable", "Operation status is temporarily unavailable.");
    const operationId = decodeURIComponent(operationMatch[1] ?? "");
    const operation = await options.openAdapter.readOperation(owner, operationId);
    if (!operation) throw new HttpFailure(404, "operation_not_found", "The operation was not found.");
    if (operation.operationId !== operationId) {
      throw new HttpFailure(503, "operation_unavailable", "Operation status is temporarily unavailable.");
    }
    jsonResponse(response, 200, serializeOperation(operation));
    return;
  }

  if (pathname.startsWith("/api/")) {
    throw new HttpFailure(404, "not_found", "The requested API route was not found.");
  }
  throw new HttpFailure(405, "method_not_allowed", "The request method is not allowed.");
}

/** Create an HTTP server. No provider means no market data and no trading service. */
export function createSilenceServer(options: SilenceServerOptions = {}): Server {
  const maximumBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const webRootPromise = realpath(resolve(options.webRoot ?? DEFAULT_WEB_ROOT));
  return createServer((request, response) => {
    setDefaultSecurityHeaders(response);
    void (async () => {
      const headOnly = request.method === "HEAD";
      const { decodedPath, url } = parseRequestTarget(request.url);
      if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
        if (request.method !== "GET" && request.method !== "POST") {
          throw new HttpFailure(405, "method_not_allowed", "The request method is not allowed.");
        }
        await routeApi(request, response, url, { ...options, maxBodyBytes: maximumBytes });
        return;
      }
      if (request.method !== "GET" && !headOnly) {
        throw new HttpFailure(405, "method_not_allowed", "The request method is not allowed.");
      }
      await serveStatic(response, decodedPath, webRootPromise, headOnly);
    })().catch((error: unknown) => {
      if (!response.headersSent) failureResponse(response, error, request.method === "HEAD");
      else response.destroy();
    });
  });
}
