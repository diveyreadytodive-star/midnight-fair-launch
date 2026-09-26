import type { BidOpening } from '../../spikes/fair-launch/generated/fair_launch/contract/index.js';
import type { CoinRecord } from './fair-launch-client.js';

const FORMAT = 'fair-launch-bid-recovery';
const ITERATIONS = 600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type BidRecovery = {
  network: 'preprod';
  contractAddress: string;
  walletCoinPublicKey: string;
  slot: number;
  mintTxId: string;
  bidTxId?: string;
  opening: BidOpening;
  paymentCoin: CoinRecord;
};

type Header = {
  format: typeof FORMAT;
  version: 1;
  network: 'preprod';
  contractAddress: string;
  walletCoinPublicKey: string;
  slot: number;
};

type EncryptedBackup = Header & {
  kdf: 'PBKDF2-SHA256';
  iterations: typeof ITERATIONS;
  salt: string;
  iv: string;
  ciphertext: string;
};

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromBase64(value: string, length?: number): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error('Invalid recovery file encoding');
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (length !== undefined && bytes.length !== length) throw new Error('Invalid recovery file length');
  return bytes;
}

function requireRecovery(value: BidRecovery): void {
  if (value.network !== 'preprod' || !/^[0-9a-f]{64}$/i.test(value.contractAddress) ||
      !value.walletCoinPublicKey || !Number.isInteger(value.slot) || value.slot < 0 || value.slot > 3 ||
      !/^[0-9a-f]{66}$/i.test(value.mintTxId) ||
      (value.bidTxId !== undefined && !/^[0-9a-f]{66}$/i.test(value.bidTxId)) ||
      value.opening.maxPrice <= 0n || value.opening.quantity <= 0n || value.opening.salt.length !== 32 ||
      value.opening.refundRecipient.bytes.length !== 32 || value.opening.tokenRecipient.bytes.length !== 32 ||
      value.paymentCoin.nonce.length !== 32 || value.paymentCoin.color.length !== 32 || value.paymentCoin.value <= 0n) {
    throw new Error('Invalid bid recovery contents');
  }
}

function headerFor(value: BidRecovery): Header {
  return { format: FORMAT, version: 1, network: value.network, contractAddress: value.contractAddress,
    walletCoinPublicKey: value.walletCoinPublicKey, slot: value.slot };
}

function encodeRecovery(value: BidRecovery): string {
  return JSON.stringify({ ...value,
    opening: { ...value.opening, maxPrice: String(value.opening.maxPrice), quantity: String(value.opening.quantity),
      refundRecipient: toBase64(value.opening.refundRecipient.bytes), tokenRecipient: toBase64(value.opening.tokenRecipient.bytes),
      salt: toBase64(value.opening.salt) },
    paymentCoin: { nonce: toBase64(value.paymentCoin.nonce), color: toBase64(value.paymentCoin.color), value: String(value.paymentCoin.value) },
  });
}

function decodeRecovery(value: string): BidRecovery {
  const raw = JSON.parse(value) as Record<string, any>;
  const result: BidRecovery = {
    network: raw.network, contractAddress: raw.contractAddress, walletCoinPublicKey: raw.walletCoinPublicKey,
    slot: raw.slot, mintTxId: raw.mintTxId, ...(raw.bidTxId === undefined ? {} : { bidTxId: raw.bidTxId }),
    opening: { maxPrice: BigInt(raw.opening.maxPrice), quantity: BigInt(raw.opening.quantity),
      refundRecipient: { bytes: fromBase64(raw.opening.refundRecipient, 32) },
      tokenRecipient: { bytes: fromBase64(raw.opening.tokenRecipient, 32) }, salt: fromBase64(raw.opening.salt, 32) },
    paymentCoin: { nonce: fromBase64(raw.paymentCoin.nonce, 32), color: fromBase64(raw.paymentCoin.color, 32),
      value: BigInt(raw.paymentCoin.value) },
  };
  requireRecovery(result);
  return result;
}

async function derive(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  if (passphrase.length < 12) throw new Error('Use a recovery passphrase of at least 12 characters');
  const key = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: ITERATIONS, hash: 'SHA-256' },
    key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptBidRecovery(value: BidRecovery, passphrase: string): Promise<string> {
  requireRecovery(value);
  const header = headerFor(value);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(JSON.stringify(header)) },
    key, encoder.encode(encodeRecovery(value)));
  const backup: EncryptedBackup = { ...header, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS,
    salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
  return JSON.stringify(backup, null, 2) + '\n';
}

export async function decryptBidRecovery(serialized: string, passphrase: string,
  expected: { contractAddress: string; walletCoinPublicKey: string }): Promise<BidRecovery> {
  if (serialized.length > 16_384) throw new Error('Recovery file is too large');
  const backup = JSON.parse(serialized) as EncryptedBackup;
  if (backup.format !== FORMAT || backup.version !== 1 || backup.network !== 'preprod' ||
      backup.kdf !== 'PBKDF2-SHA256' || backup.iterations !== ITERATIONS ||
      backup.contractAddress !== expected.contractAddress || backup.walletCoinPublicKey !== expected.walletCoinPublicKey ||
      !Number.isInteger(backup.slot) || backup.slot < 0 || backup.slot > 3) {
    throw new Error('Recovery file does not match this wallet and auction');
  }
  const header: Header = { format: backup.format, version: backup.version, network: backup.network,
    contractAddress: backup.contractAddress, walletCoinPublicKey: backup.walletCoinPublicKey, slot: backup.slot };
  const salt = fromBase64(backup.salt, 16);
  const iv = fromBase64(backup.iv, 12);
  const ciphertext = fromBase64(backup.ciphertext);
  if (ciphertext.length < 17 || ciphertext.length > 8_192) throw new Error('Invalid recovery ciphertext length');
  const key = await derive(passphrase, salt);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: encoder.encode(JSON.stringify(header)) },
    key, ciphertext as BufferSource);
  const value = decodeRecovery(decoder.decode(plaintext));
  if (value.contractAddress !== header.contractAddress || value.walletCoinPublicKey !== header.walletCoinPublicKey || value.slot !== header.slot) {
    throw new Error('Recovery file header mismatch');
  }
  return value;
}
