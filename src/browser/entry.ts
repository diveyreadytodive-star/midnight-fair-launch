import { Buffer } from 'buffer';
import { createFairLaunchBrowserClient, verifyBrowserZkAssets } from './fair-launch-client.js';

Object.assign(globalThis, { Buffer });

export { createFairLaunchBrowserClient };
export { verifyBrowserZkAssets };
export { encryptBidRecovery, decryptBidRecovery } from './bid-backup.js';
