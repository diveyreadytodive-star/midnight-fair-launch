import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type Receipt = { readonly txId: string; readonly transactionHash: string; readonly blockHeight: number };
type Recovery = {
  readonly status: string;
  readonly bidderOpenings: readonly string[];
  readonly bidderKeyHexes: readonly string[];
  readonly actions: Readonly<Record<string, Receipt>>;
};

const INDEXER = 'http://127.0.0.1:28088/api/v4/graphql';

function integerEncodings(value: bigint): string[] {
  const bytes = new Uint8Array(8);
  let remaining = value;
  for (let index = 0; index < 8; index += 1) { bytes[index] = Number(remaining & 0xffn); remaining >>= 8n; }
  return [Buffer.from(bytes).toString('hex'), Buffer.from(bytes).reverse().toString('hex')];
}

async function queryPublicFields(stage: string, receipt: Receipt): Promise<{ raw: string; structured: string }> {
  assert.match(receipt.txId, /^[0-9a-fA-F]{66}$/);
  const query = `query RawAudit { transactions(offset: { identifier: "${receipt.txId}" }) { hash raw block { height } contractActions { __typename ... on ContractCall { state zswapState } } } }`;
  const response = await fetch(INDEXER, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }), signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json() as { data?: { transactions?: { hash?: unknown; raw?: unknown; block?: { height?: unknown }; contractActions?: { state?: unknown; zswapState?: unknown }[] }[] }; errors?: unknown[] };
  if (!response.ok || body.errors?.length) throw new Error(`Indexer raw query failed for ${stage}.`);
  const transaction = body.data?.transactions?.[0];
  if (!transaction || transaction.hash !== receipt.transactionHash || Number(transaction.block?.height) !== receipt.blockHeight || typeof transaction.raw !== 'string') {
    throw new Error(`Indexed transaction does not match the saved ${stage} receipt.`);
  }
  const structured = (transaction.contractActions ?? []).flatMap((action) => [action.state, action.zswapState]);
  if (structured.some((field) => field != null && typeof field !== 'string')) throw new Error(`Invalid structured contract fields for ${stage}.`);
  return {
    raw: transaction.raw.replace(/^0x/, '').toLowerCase(),
    structured: structured.filter((field): field is string => typeof field === 'string').map((field) => field.replace(/^0x/, '').toLowerCase()).join(''),
  };
}

async function main(): Promise<void> {
  const recovery = JSON.parse(await readFile(resolve('.local/fair-launch-recovery/recovery.json'), 'utf8')) as Recovery;
  if (recovery.status !== 'complete' || Object.keys(recovery.actions).length !== 20 || recovery.bidderOpenings.length !== 4 || recovery.bidderKeyHexes.length !== 4) {
    throw new Error('The protected Local Devnet run is not the expected completed four-slot fixture.');
  }
  const openings = recovery.bidderOpenings.map((serialized, slot) => {
    const parsed = JSON.parse(serialized) as { saltHex?: unknown };
    if (typeof parsed.saltHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(parsed.saltHex)) throw new Error(`Missing protected opening salt for slot ${slot}.`);
    const opening = parsed as { saltHex: string; maxPrice?: unknown; quantity?: unknown };
    if (typeof opening.maxPrice !== 'string' || !/^\d+$/.test(opening.maxPrice) || typeof opening.quantity !== 'string' || !/^\d+$/.test(opening.quantity)) {
      throw new Error(`Protected opening values are invalid for slot ${slot}.`);
    }
    return { salt: opening.saltHex.toLowerCase(), maxPrice: BigInt(opening.maxPrice), quantity: BigInt(opening.quantity) };
  });
  const recipients = recovery.bidderKeyHexes.map((key, slot) => {
    if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error(`Missing protected recipient key for slot ${slot}.`);
    return key.toLowerCase();
  });
  const saltMatches = openings.map((_, slot) => ({ slot, rawStages: [] as string[], structuredStages: [] as string[] }));
  const recipientMatches = recipients.map((_, slot) => ({ slot, rawStages: [] as string[], structuredStages: [] as string[] }));
  const numericPatterns = openings.map((_, slot) => ({ slot, maxPrice: { raw: false, structured: false, unrelatedControl: false }, quantity: { raw: false, structured: false, unrelatedControl: false } }));
  const unrelatedControls: string[] = [];
  const receipts = Object.entries(recovery.actions);
  for (const [stage, receipt] of receipts) {
    const fields = await queryPublicFields(stage, receipt);
    if (stage === 'deploy' || stage === 'mint-sale-inventory') unrelatedControls.push(fields.raw + fields.structured);
    openings.forEach((opening, slot) => {
      if (fields.raw.includes(opening.salt)) saltMatches[slot].rawStages.push(stage);
      if (fields.structured.includes(opening.salt)) saltMatches[slot].structuredStages.push(stage);
      if (stage !== `register-bid-${slot}`) return;
      for (const [field, value] of [['maxPrice', opening.maxPrice], ['quantity', opening.quantity]] as const) {
        const encodings = integerEncodings(value);
        numericPatterns[slot][field].raw = encodings.some((encoding) => fields.raw.includes(encoding));
        numericPatterns[slot][field].structured = encodings.some((encoding) => fields.structured.includes(encoding));
      }
    });
    recipients.forEach((key, slot) => {
      if (fields.raw.includes(key)) recipientMatches[slot].rawStages.push(stage);
      if (fields.structured.includes(key)) recipientMatches[slot].structuredStages.push(stage);
    });
  }
  for (const [slot, opening] of openings.entries()) {
    for (const [field, value] of [['maxPrice', opening.maxPrice], ['quantity', opening.quantity]] as const) {
      numericPatterns[slot][field].unrelatedControl = integerEncodings(value).some((encoding) => unrelatedControls.some((control) => control.includes(encoding)));
    }
  }
  process.stdout.write(JSON.stringify({
    network: 'local-devnet',
    auditKind: 'targeted-direct-hex-search-only',
    receiptCountRequeried: receipts.length,
    saltMatches,
    recipientKeyMatches: recipientMatches,
    registrationNumericPatternMatches: numericPatterns,
    interpretation: 'Direct 32-byte matches and 8-byte numeric patterns are only targeted probes. A match can be ambiguous; no match does not prove broader privacy. Other encodings, inference, logs, operator knowledge, and post-settlement disclosure remain outside this check.',
  }) + '\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`Recorded raw audit failed: ${error instanceof Error ? error.name : 'UnknownError'}\n`);
  process.exitCode = 1;
});
