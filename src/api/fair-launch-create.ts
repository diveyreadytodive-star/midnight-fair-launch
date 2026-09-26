import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface FairLaunchMetadata {
  readonly name: string;
  readonly ticker: string;
  readonly imageUrl: string | null;
  readonly description: string;
}

export interface FairLaunchConfig {
  readonly inventoryAtoms: string;
  readonly reservePriceAtoms: string;
  readonly depositLotAtoms: string;
  readonly commitWindowSeconds: number;
  readonly openWindowSeconds: number;
}

export interface FairLaunchCreateRequest {
  readonly metadata: FairLaunchMetadata;
  readonly config: FairLaunchConfig;
}

export interface FairLaunchReceiptRef {
  readonly txId: string;
  readonly transactionHash: string;
  readonly blockHeight: number;
}

export interface FairLaunchEntry {
  readonly id: string;
  readonly contractAddress: string;
  readonly metadata: FairLaunchMetadata | {
    readonly name: null;
    readonly ticker: null;
    readonly imageUrl: null;
    readonly description: null;
  };
  readonly config: FairLaunchConfig;
  readonly phase: "commit" | "open" | "settled" | "cancelled" | "unknown";
  readonly createdAt: string;
  readonly commitDeadlineUnixSeconds?: string;
  readonly openDeadlineUnixSeconds?: string;
  readonly metadataAnchored: boolean;
  readonly metadataCommitmentHex: string | null;
  readonly artworkBytesAnchored: false;
  readonly evidenceSource: "recorded-local-devnet-evidence" | "verified-local-devnet-create";
  readonly receipts: {
    readonly deploy: FairLaunchReceiptRef;
    readonly mint: FairLaunchReceiptRef;
    readonly fund: FairLaunchReceiptRef;
  };
  readonly settlement?: {
    readonly clearingPriceAtoms: string;
    readonly allocationsAtoms: readonly string[];
    readonly refundsAtoms: readonly string[];
    readonly tokenClaimed: readonly boolean[];
    readonly refundClaimed: readonly boolean[];
  };
}

export interface FairLaunchSnapshot {
  readonly live: boolean;
  readonly writable: boolean;
  readonly network: "local-devnet";
  readonly mode: "local-devnet-operator-demo";
  readonly capabilities: { readonly canCreate: boolean };
  readonly launches: readonly FairLaunchEntry[];
}

export class FairLaunchInputError extends Error {
  constructor(message = "The launch details are invalid.") {
    super(message);
    this.name = "FairLaunchInputError";
  }
}

export class FairLaunchCreateUnavailableError extends Error {
  constructor(message = "Local Devnet token creation is not available.") {
    super(message);
    this.name = "FairLaunchCreateUnavailableError";
  }
}

export class FairLaunchCreateBusyError extends Error {
  constructor() {
    super("A Fair Launch create operation is already running.");
    this.name = "FairLaunchCreateBusyError";
  }
}

export class FairLaunchRecoveryRequiredError extends Error {
  constructor(readonly operationId: string) {
    super("A partial Local Devnet operation needs manual recovery. No retry was made.");
    this.name = "FairLaunchRecoveryRequiredError";
  }
}

export interface FairLaunchCreateAdapter {
  getSnapshot(): Promise<FairLaunchSnapshot>;
  create(input: unknown): Promise<FairLaunchEntry>;
}

export interface FairLaunchCreateAdapterOptions {
  readonly catalogPath?: string;
  readonly runnerPath?: string;
  readonly projectRoot?: string;
  readonly enabled?: () => boolean;
  readonly seed?: () => string | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly probe?: (network: LocalDevnetEndpoints) => Promise<boolean>;
}

export interface LocalDevnetEndpoints {
  readonly indexer: string;
  readonly indexerWS: string;
  readonly node: string;
  readonly proofServer: string;
}

export const DEFAULT_FAIR_LAUNCH_CATALOG = fileURLToPath(new URL("../../web/fair-launch-catalog.json", import.meta.url));
const DEFAULT_PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_RUNNER = join(DEFAULT_PROJECT_ROOT, "spikes/fair-launch/scripts/create-launch.ts");
const UINT64_MAX = 18_446_744_073_709_551_615n;
const MAX_BODY_BYTES = 12 * 1024;
const MAX_RUNNER_OUTPUT_BYTES = 48 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && Object.keys(value).every((key) => expected.includes(key));
}

function parseAmount(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 20 || !/^[1-9]\d*$/.test(value)) return null;
  const amount = BigInt(value);
  return amount <= UINT64_MAX ? amount.toString() : null;
}

function parseWindow(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 300 && Number(value) <= 86_400 ? Number(value) : null;
}

function canonicalMetadata(value: unknown): FairLaunchMetadata {
  if (!isRecord(value) || !exactKeys(value, ["name", "ticker", "imageUrl", "description"])) throw new FairLaunchInputError();
  const { name, ticker, imageUrl, description } = value;
  if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 48 || /[\r\n\0]/.test(name)) {
    throw new FairLaunchInputError("Token name must contain 1 to 48 characters.");
  }
  if (typeof ticker !== "string" || !/^[a-zA-Z][a-zA-Z0-9]{1,9}$/.test(ticker.trim())) {
    throw new FairLaunchInputError("Ticker must be 2 to 10 letters or numbers and start with a letter.");
  }
  if (typeof description !== "string" || description.length > 500 || /\0/.test(description)) {
    throw new FairLaunchInputError("Description can contain up to 500 characters.");
  }
  let normalizedImageUrl: string | null = null;
  if (imageUrl !== null && (typeof imageUrl !== "string" || imageUrl.length > 2048)) throw new FairLaunchInputError("Image URL is invalid.");
  if (typeof imageUrl === "string" && imageUrl.trim()) {
    let parsed: URL;
    try { parsed = new URL(imageUrl.trim()); } catch { throw new FairLaunchInputError("Image URL must be an HTTPS URL."); }
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
      throw new FairLaunchInputError("Image URL must be an HTTPS URL without credentials or a fragment.");
    }
    normalizedImageUrl = parsed.toString();
  }
  return { name: name.trim(), ticker: ticker.trim().toUpperCase(), imageUrl: normalizedImageUrl, description: description.trim() };
}

export function validateFairLaunchCreateRequest(value: unknown): FairLaunchCreateRequest {
  if (!isRecord(value) || !exactKeys(value, ["metadata", "config"]) || !isRecord(value.config) ||
      !exactKeys(value.config, ["inventoryAtoms", "reservePriceAtoms", "depositLotAtoms", "commitWindowSeconds", "openWindowSeconds"])) {
    throw new FairLaunchInputError();
  }
  const inventoryAtoms = parseAmount(value.config.inventoryAtoms);
  const reservePriceAtoms = parseAmount(value.config.reservePriceAtoms);
  const depositLotAtoms = parseAmount(value.config.depositLotAtoms);
  const commitWindowSeconds = parseWindow(value.config.commitWindowSeconds);
  const openWindowSeconds = parseWindow(value.config.openWindowSeconds);
  if (!inventoryAtoms || !reservePriceAtoms || !depositLotAtoms || commitWindowSeconds === null || openWindowSeconds === null) {
    throw new FairLaunchInputError("Amounts must be positive integer atoms and auction windows must be 300 to 86,400 seconds.");
  }
  if (BigInt(reservePriceAtoms) * BigInt(inventoryAtoms) > BigInt(depositLotAtoms)) {
    throw new FairLaunchInputError("Deposit must cover the inventory at the reserve price.");
  }
  return {
    metadata: canonicalMetadata(value.metadata),
    config: { inventoryAtoms, reservePriceAtoms, depositLotAtoms, commitWindowSeconds, openWindowSeconds },
  };
}

export function fairLaunchMetadataCommitment(input: FairLaunchCreateRequest): string {
  const canonical = JSON.stringify({
    version: 1,
    metadata: input.metadata,
    config: input.config,
  });
  return createHash("sha256").update("FAIR-LAUNCH/METADATA-ANCHOR/v1\0").update(canonical).digest("hex");
}

export function localDevnetEndpoints(env: NodeJS.ProcessEnv = process.env): LocalDevnetEndpoints {
  return {
    indexer: env.SILENCE_INDEXER_URL ?? "http://127.0.0.1:28088/api/v4/graphql",
    indexerWS: env.SILENCE_INDEXER_WS_URL ?? "ws://127.0.0.1:28088/api/v4/graphql/ws",
    node: env.SILENCE_NODE_URL ?? "ws://127.0.0.1:29944",
    proofServer: env.SILENCE_PROOF_SERVER_URL ?? "http://127.0.0.1:26300",
  };
}

export function assertLocalDevnetEndpoints(endpoints: LocalDevnetEndpoints): void {
  const expected = [
    { value: endpoints.indexer, protocol: "http:", port: "28088", path: "/api/v4/graphql" },
    { value: endpoints.indexerWS, protocol: "ws:", port: "28088", path: "/api/v4/graphql/ws" },
    { value: endpoints.node, protocol: "ws:", port: "29944", path: "/" },
    { value: endpoints.proofServer, protocol: "http:", port: "26300", path: "/" },
  ];
  for (const item of expected) {
    let url: URL;
    try { url = new URL(item.value); } catch { throw new FairLaunchCreateUnavailableError(); }
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password ||
        url.protocol !== item.protocol || url.port !== item.port || url.pathname !== item.path || url.search || url.hash) {
      throw new FairLaunchCreateUnavailableError("Fair Launch Create only accepts the canonical Local Devnet endpoints.");
    }
  }
}

function tcpReachable(urlText: string): Promise<boolean> {
  return new Promise((resolveReachable) => {
    try {
      const url = new URL(urlText);
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const socket = connect({ host, port: Number(url.port) });
      const finish = (reachable: boolean) => {
        socket.destroy();
        resolveReachable(reachable);
      };
      socket.setTimeout(900, () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    } catch { resolveReachable(false); }
  });
}

export async function probeLocalDevnet(endpoints: LocalDevnetEndpoints): Promise<boolean> {
  try {
    assertLocalDevnetEndpoints(endpoints);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 900);
    const [indexerResponse, nodeReachable, proofReachable] = await Promise.all([
      fetch(endpoints.indexer, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "query FairLaunchHealth { __typename }" }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout)),
      tcpReachable(endpoints.node),
      tcpReachable(endpoints.proofServer),
    ]);
    if (!indexerResponse.ok || !nodeReachable || !proofReachable) return false;
    const body = await indexerResponse.json() as { data?: { __typename?: unknown }; errors?: unknown[] };
    return body.data?.__typename === "Query" && !body.errors?.length;
  } catch { return false; }
}

async function readCatalogFile(path: string): Promise<FairLaunchEntry[]> {
  let document: unknown;
  try { document = JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Fair Launch catalog is missing.");
    throw new Error("Fair Launch catalog could not be read.");
  }
  if (!isRecord(document) || document.version !== 1 || !Array.isArray(document.launches)) throw new Error("Fair Launch catalog is invalid.");
  return document.launches as FairLaunchEntry[];
}

export async function readFairLaunchCatalog(path = DEFAULT_FAIR_LAUNCH_CATALOG): Promise<FairLaunchEntry[]> {
  return readCatalogFile(path);
}

export async function appendFairLaunchCatalogEntry(entry: FairLaunchEntry, path = DEFAULT_FAIR_LAUNCH_CATALOG): Promise<void> {
  const launches = await readCatalogFile(path);
  if (launches.some((launch) => launch.contractAddress === entry.contractAddress)) throw new Error("Launch is already present in the catalog.");
  const catalogPath = resolve(path);
  const temporary = `${catalogPath}.tmp-${process.pid}-${randomUUID()}`;
  const payload = `${JSON.stringify({ version: 1, launches: [...launches, entry] }, null, 2)}\n`;
  await writeFile(temporary, payload, { encoding: "utf8", flag: "wx", mode: 0o644 });
  try { await rename(temporary, catalogPath); }
  catch (error) {
    const { unlink } = await import("node:fs/promises");
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  const saved = await readCatalogFile(catalogPath);
  if (!saved.some((launch) => launch.contractAddress === entry.contractAddress)) throw new Error("Launch catalog readback failed.");
}

function isSeedConfigured(seed: string | undefined): seed is string {
  return typeof seed === "string" && /^(?:[0-9a-fA-F]{2}){32}$/.test(seed.trim());
}

function childEnvironment(env: NodeJS.ProcessEnv, seed: string): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = { FAIR_LAUNCH_CREATE_ENABLED: "1", FAIR_LAUNCH_LOCAL_TEST_SEED: seed };
  for (const key of ["PATH", "HOME", "TMPDIR", "SILENCE_INDEXER_URL", "SILENCE_INDEXER_WS_URL", "SILENCE_NODE_URL", "SILENCE_PROOF_SERVER_URL"]) {
    if (env[key]) selected[key] = env[key];
  }
  return selected;
}

async function runCreateRunner(runnerPath: string, projectRoot: string, env: NodeJS.ProcessEnv, seed: string, input: unknown): Promise<{ output: string; exitCode: number | null }> {
  return await new Promise<{ output: string; exitCode: number | null }>((resolveOutput, rejectOutput) => {
    const child = spawn(process.execPath, ["--import", "tsx", runnerPath], {
      cwd: projectRoot,
      env: childEnvironment(env, seed),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let exceededOutput = false;
    child.stdout.setEncoding("utf8");
    child.stderr.resume();
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_RUNNER_OUTPUT_BYTES) {
        exceededOutput = true;
        child.kill("SIGTERM");
      }
    });
    child.once("error", () => rejectOutput(new Error("Fair Launch create runner could not start.")));
    child.once("close", (code) => {
      if (exceededOutput || !stdout.trim()) rejectOutput(new Error("Fair Launch runner stopped before returning a result."));
      else resolveOutput({ output: stdout, exitCode: code });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export function createFairLaunchCreateAdapter(options: FairLaunchCreateAdapterOptions = {}): FairLaunchCreateAdapter {
  const env = options.env ?? process.env;
  const projectRoot = resolve(options.projectRoot ?? DEFAULT_PROJECT_ROOT);
  const catalogPath = resolve(options.catalogPath ?? DEFAULT_FAIR_LAUNCH_CATALOG);
  const runnerPath = resolve(options.runnerPath ?? DEFAULT_RUNNER);
  const enabled = options.enabled ?? (() => env.FAIR_LAUNCH_CREATE_ENABLED === "1");
  const readSeed = options.seed ?? (() => env.FAIR_LAUNCH_LOCAL_TEST_SEED);
  const checkNetwork = options.probe ?? probeLocalDevnet;
  let running = false;

  async function snapshot(includeActiveOperation: boolean): Promise<FairLaunchSnapshot> {
    const storedLaunches = await readFairLaunchCatalog(catalogPath);
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    const launches = storedLaunches.map((launch): FairLaunchEntry => {
      if (launch.phase === "settled" || launch.phase === "cancelled" || !launch.commitDeadlineUnixSeconds || !launch.openDeadlineUnixSeconds) return launch;
      const commitDeadline = BigInt(launch.commitDeadlineUnixSeconds);
      const openDeadline = BigInt(launch.openDeadlineUnixSeconds);
      const phase: FairLaunchEntry["phase"] = nowSeconds < commitDeadline ? "commit" : nowSeconds < openDeadline ? "open" : "unknown";
      return { ...launch, phase };
    }).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    let live = false;
    const endpoints = localDevnetEndpoints(env);
    try { assertLocalDevnetEndpoints(endpoints); live = await checkNetwork(endpoints); } catch { live = false; }
    const lockPath = join(projectRoot, ".local/fair-launch-create-recovery/runner.lock");
    let locked = includeActiveOperation && running;
    try { await access(lockPath); locked = true; } catch { /* no recovery lock */ }
    const writable = live && enabled() && isSeedConfigured(readSeed()) && !locked;
    return {
      live,
      writable,
      network: "local-devnet",
      mode: "local-devnet-operator-demo",
      capabilities: { canCreate: writable },
      launches,
    };
  }

  return {
    getSnapshot() { return snapshot(true); },
    async create(value) {
      const input = validateFairLaunchCreateRequest(value);
      if (running) throw new FairLaunchCreateBusyError();
      running = true;
      const operationId = randomUUID();
      try {
        const current = await snapshot(false);
        if (!current.capabilities.canCreate) throw new FairLaunchCreateUnavailableError();
        const seed = readSeed()?.trim();
        if (!isSeedConfigured(seed)) throw new FairLaunchCreateUnavailableError();
        const endpoints = localDevnetEndpoints(env);
        assertLocalDevnetEndpoints(endpoints);
        const runnerResult = await runCreateRunner(runnerPath, projectRoot, env, seed, { operationId, input });
        let result: unknown;
        try { result = JSON.parse(runnerResult.output) as unknown; } catch { throw new FairLaunchRecoveryRequiredError(operationId); }
        if (isRecord(result) && result.status === "rejected") throw new FairLaunchCreateUnavailableError();
        if (isRecord(result) && result.status === "recovery-required") throw new FairLaunchRecoveryRequiredError(operationId);
        if (runnerResult.exitCode !== 0 || !isRecord(result) || result.status !== "confirmed" || !isRecord(result.launch)) {
          throw new FairLaunchRecoveryRequiredError(operationId);
        }
        const launch = result.launch as unknown as FairLaunchEntry;
        const catalog = await readFairLaunchCatalog(catalogPath);
        if (!catalog.some((candidate) => candidate.contractAddress === launch.contractAddress)) {
          throw new Error("Runner launch was not persisted to the catalog.");
        }
        return launch;
      } catch (error) {
        if (error instanceof FairLaunchInputError || error instanceof FairLaunchCreateUnavailableError || error instanceof FairLaunchCreateBusyError || error instanceof FairLaunchRecoveryRequiredError) {
          throw error;
        }
        throw new FairLaunchRecoveryRequiredError(operationId);
      } finally {
        running = false;
      }
    },
  };
}
