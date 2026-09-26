import { Buffer } from 'buffer';
import { createFairLaunchBrowserClient, readPreprodAuction, verifyBrowserZkAssets } from './fair-launch-client.js';

Object.assign(globalThis, { Buffer });

export { createFairLaunchBrowserClient };
export { verifyBrowserZkAssets };
export { readPreprodAuction };
export { encryptBidRecovery, decryptBidRecovery } from './bid-backup.js';
