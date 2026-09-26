import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SilenceChainClient,
  type ChainReceipt,
  type CommitPositionInput,
  type OwnerTargetWitness,
  type PositionTerms,
  type PublicPositionSnapshot,
} from '../../src/chain/client.js';

type IntentPhase = 'pending' | 'active' | 'closed';

interface TestOwnerIntent {
  readonly version: 1;
  readonly phase: IntentPhase;
  readonly terms: PositionTerms;
  readonly positionSalt: Uint8Array;
  readonly ownerCloseSecret: Uint8Array;
  readonly ownerTarget: OwnerTargetWitness;
  readonly expectedOwnerIdentityCommitment: Uint8Array;
  readonly expectedOwnerRecipientCommitment: Uint8Array;
  readonly expectedPositionCommitment: Uint8Array;
}

const fixedBytes = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const asHex = (value: Uint8Array): string => Buffer.from(value).toString('hex');

function makeIntent(phase: IntentPhase): TestOwnerIntent {
  return {
    version: 1,
    phase,
    terms: {
      side: true,
      notionalAtoms: 500_000_000n,
      entryPriceTicks: 65_000_000_000n,
      guardBufferAtoms: 20_000_000n,
    },
    positionSalt: fixedBytes(11),
    ownerCloseSecret: fixedBytes(13),
    ownerTarget: {
      ownerRecipient: { bytes: fixedBytes(17) },
      recipientSalt: fixedBytes(19),
    },
    expectedOwnerIdentityCommitment: fixedBytes(23),
    expectedOwnerRecipientCommitment: fixedBytes(29),
    expectedPositionCommitment: fixedBytes(31),
  };
}

function publicState(intent: TestOwnerIntent, overrides: Partial<PublicPositionSnapshot> = {}): PublicPositionSnapshot {
  return {
    networkDomain: asHex(fixedBytes(3)),
    marketId: asHex(fixedBytes(5)),
    protocolVersion: '1',
    collateralValueAtoms: '1000000000',
    collateralMtIndex: '37',
    ownerIdentityCommitment: asHex(intent.expectedOwnerIdentityCommitment),
    ownerRecipientCommitment: asHex(intent.expectedOwnerRecipientCommitment),
    positionCommitment: asHex(intent.expectedPositionCommitment),
    positionActive: true,
    settled: false,
    ...overrides,
  };
}

function commitInput(): CommitPositionInput {
  return {
    coin: { nonce: fixedBytes(7), color: fixedBytes(9), value: 1_000_000_000n },
    terms: {
      side: false,
      notionalAtoms: 400_000_000n,
      entryPriceTicks: 64_000_000_000n,
      guardBufferAtoms: 18_000_000n,
    },
    positionSalt: fixedBytes(37),
    ownerCloseSecret: fixedBytes(41),
    ownerTarget: {
      ownerRecipient: { bytes: fixedBytes(43) },
      recipientSalt: fixedBytes(47),
    },
  };
}

function testClient(initialIntent: TestOwnerIntent, initialPublicState: PublicPositionSnapshot) {
  const receipt: ChainReceipt = {
    txId: 'test-owner-close',
    status: 'SucceedEntirely',
    blockHeight: 164,
  };
  let storedIntent: unknown = initialIntent;
  let state = initialPublicState;
  let writes = 0;
  const invocations: string[] = [];
  const privateStateProvider = {
    async get(_key: string): Promise<unknown> {
      return storedIntent;
    },
    async set(_key: string, value: unknown): Promise<void> {
      writes += 1;
      storedIntent = value;
    },
  };
  const client = Object.create(SilenceChainClient.prototype) as SilenceChainClient;
  Object.defineProperty(client, 'providers', {
    value: { privateStateProvider },
    configurable: true,
  });
  Object.defineProperty(client, 'invoke', {
    value: async (circuit: string): Promise<{ readonly receipt: ChainReceipt; readonly privateResult: unknown }> => {
      invocations.push(circuit);
      if (circuit === 'ownerClose') state = { ...state, positionActive: false, settled: true };
      return { receipt, privateResult: undefined };
    },
    configurable: true,
  });
  Object.defineProperty(client, 'readPublicPosition', {
    value: async (): Promise<PublicPositionSnapshot> => state,
    configurable: true,
  });
  return {
    client,
    receipt,
    readIntent: () => storedIntent as TestOwnerIntent,
    get writes() { return writes; },
    invocations,
  };
}

test('duplicate commit preserves the active owner intent so ownerClose can still recover the lot', async () => {
  const activeIntent = makeIntent('active');
  const test = testClient(activeIntent, publicState(activeIntent));

  await assert.rejects(
    test.client.commitPosition(commitInput()),
    /active owner position already exists/,
  );
  assert.equal(test.writes, 0);
  assert.deepEqual(test.readIntent(), activeIntent);

  assert.deepEqual(await test.client.ownerClose(), test.receipt);
  assert.equal(test.readIntent().phase, 'closed');
  assert.deepEqual(test.invocations, ['ownerClose']);
});

test('uncertain pending intent cannot be overwritten and mismatched public state stays blocked', async () => {
  const pendingIntent = makeIntent('pending');
  const mismatchedState = publicState(pendingIntent, {
    positionCommitment: asHex(fixedBytes(53)),
  });
  const test = testClient(pendingIntent, mismatchedState);

  await assert.rejects(
    test.client.commitPosition(commitInput()),
    /pending owner position intent must be reconciled/,
  );
  await assert.rejects(
    test.client.ownerClose(),
    /does not match an active, unsettled public position/,
  );
  assert.equal(test.writes, 0);
  assert.deepEqual(test.readIntent(), pendingIntent);
  assert.deepEqual(test.invocations, []);
});

test('matching pending intent is promoted only after public commitment readback, then ownerClose succeeds', async () => {
  const pendingIntent = makeIntent('pending');
  const test = testClient(pendingIntent, publicState(pendingIntent));

  assert.deepEqual(await test.client.ownerClose(), test.receipt);
  assert.equal(test.readIntent().phase, 'closed');
  assert.equal(test.writes, 2);
  assert.deepEqual(test.invocations, ['ownerClose']);
});
