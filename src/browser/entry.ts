import { Buffer } from 'buffer';
import { createFairLaunchBrowserClient } from './fair-launch-client.js';

Object.assign(globalThis, { Buffer });

export { createFairLaunchBrowserClient };
export { encryptBidRecovery, decryptBidRecovery } from './bid-backup.js';
